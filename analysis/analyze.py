"""Post-hoc acoustic analysis for voicetrain recordings.

Reads one WAV and prints one JSON document on stdout: per-axis metrics
(pitch, melody, resonance, breath, weight) plus time-anchored events
(fry, monotone, long_phrase) that the server stores as annotations.

Praat (via parselmouth) does the heavy lifting — the same measurements
speech pathologists use for voice work. Everything runs offline.

Connected-speech caveats, so downstream copy stays honest:
- formants from continuous speech on a laptop mic are noisy; report
  them as per-take medians and trust trends, not single takes
- jitter/shimmer norms assume sustained vowels; on running speech they
  are only useful relative to the speaker's own history
"""

import argparse
import json
import math
import sys

import numpy as np
import parselmouth
from parselmouth.praat import call

ANALYSIS_VERSION = 1

TIME_STEP = 0.01
PITCH_FLOOR = 60.0  # low enough to see fry
PITCH_CEILING = 500.0
# Validated against real takes: 0.45/0.01 (Praat defaults) voiced
# breath noise at the pitch floor and halved 130-150 Hz speech into
# phantom 65 Hz "fry" (subharmonic octave errors). 0.6/0.05 removes
# both while leaving genuine fry — which has no modal competitor and
# therefore isn't affected by the octave penalty — intact.
VOICING_THRESHOLD = 0.6
OCTAVE_COST = 0.05

FRY_MAX_HZ = 105.0
FRY_MIN_S = 0.12
FRY_MERGE_GAP_S = 0.25

MONOTONE_MIN_PHRASE_S = 2.0
MONOTONE_MAX_RANGE_ST = 2.0

LONG_PHRASE_S = 7.0

MIN_PAUSE_S = 0.25
MIN_SOUNDING_S = 0.1

# Syllable nuclei (de Jong & Wempe style): an intensity peak counts as
# a nucleus if it is voiced and rises >= 2 dB above the preceding dip.
NUCLEUS_DIP_DB = 2.0

MAX_EVENTS = 60
CONTOUR_STEP_S = 0.25


def num(x, digits=1):
    """Round to a JSON-safe number, mapping NaN/inf to None."""
    if x is None:
        return None
    x = float(x)
    if math.isnan(x) or math.isinf(x):
        return None
    return round(x, digits)


def semitones(hz, ref):
    return 12.0 * np.log2(hz / ref)


def runs_from_mask(mask, times, merge_gap_s, min_len_s):
    """Contiguous True runs as [(t0, t1)], merged across small gaps."""
    runs = []
    start = None
    for i, on in enumerate(mask):
        if on and start is None:
            start = times[i]
        elif not on and start is not None:
            runs.append((start, times[i - 1]))
            start = None
    if start is not None:
        runs.append((start, times[-1]))

    merged = []
    for t0, t1 in runs:
        if merged and t0 - merged[-1][1] <= merge_gap_s:
            merged[-1] = (merged[-1][0], t1)
        else:
            merged.append((t0, t1))
    return [(t0, t1) for t0, t1 in merged if t1 - t0 >= min_len_s]


def silence_cutoff_db(iv):
    """Otsu threshold between the noise and speech intensity modes.

    A fixed "max - 25 dB" cutoff fails on real recordings: untreated
    rooms put the noise floor within 25 dB of speech peaks, so pauses
    are never detected. The intensity histogram is reliably bimodal
    (noise vs speech); Otsu finds the valley per-recording.
    """
    peak = float(np.max(iv))
    vals = iv[iv > peak - 60]  # ignore digital silence
    if len(vals) < 10:
        return peak - 25.0

    hist, edges = np.histogram(vals, bins=64)
    mids = (edges[:-1] + edges[1:]) / 2
    total = hist.sum()
    weighted_sum = float((hist * mids).sum())
    best_var, cutoff = -1.0, peak - 25.0
    w0 = c0 = 0.0
    for i in range(len(hist)):
        w0 += hist[i]
        c0 += hist[i] * mids[i]
        w1 = total - w0
        if w0 == 0 or w1 == 0:
            continue
        between = w0 * w1 * (c0 / w0 - (weighted_sum - c0) / w1) ** 2
        if between > best_var:
            best_var, cutoff = between, float(mids[i])
    # A degenerate histogram (near-silent take, constant noise) can put
    # the "valley" anywhere; keep the cutoff in a speech-plausible band.
    return min(max(cutoff, peak - 35.0), peak - 10.0)


def detect_phrases(intensity):
    """(phrases, pauses) as [(t0, t1)] from the intensity contour.

    Pauses are only the gaps BETWEEN phrases; lead-in and tail silence
    around the take say nothing about breath management.
    """
    iv = intensity.values[0]
    ts = intensity.xs()
    cutoff = silence_cutoff_db(iv)

    silent_runs = runs_from_mask(iv < cutoff, ts, 0.0, MIN_PAUSE_S)
    bounds = [ts[0]] + [t for run in silent_runs for t in run] + [ts[-1]]
    phrases = [
        (bounds[i], bounds[i + 1])
        for i in range(0, len(bounds) - 1, 2)
        if bounds[i + 1] - bounds[i] >= MIN_SOUNDING_S
    ]
    if not phrases:
        return [], []
    pauses = [
        (t0, t1)
        for t0, t1 in silent_runs
        if t0 > phrases[0][0] and t1 < phrases[-1][1]
    ]
    return phrases, pauses


def make_voiced_lookup(pitch_times, freqs):
    """voiced(t) -> bool, by nearest pitch frame."""
    t0 = pitch_times[0]
    dt = TIME_STEP

    def voiced(t):
        i = int(round((t - t0) / dt))
        return 0 <= i < len(freqs) and freqs[i] > 0

    return voiced


def count_syllable_nuclei(intensity, voiced, phrases):
    """Voiced intensity peaks with a >= 2 dB dip between them."""
    vals = intensity.values[0]
    ts = intensity.xs()
    cutoff = silence_cutoff_db(vals)

    in_phrase = np.zeros(len(ts), dtype=bool)
    for t0, t1 in phrases:
        in_phrase |= (ts >= t0) & (ts <= t1)

    count = 0
    last_peak_i = None
    for i in range(1, len(vals) - 1):
        if not in_phrase[i] or vals[i] <= cutoff:
            continue
        if not (vals[i] > vals[i - 1] and vals[i] >= vals[i + 1]):
            continue
        if not voiced(ts[i]):
            continue
        if last_peak_i is not None:
            dip = float(np.min(vals[last_peak_i : i + 1]))
            if vals[i] - dip < NUCLEUS_DIP_DB:
                # Same syllable as the previous peak; keep whichever
                # peak is taller as the reference.
                if vals[i] > vals[last_peak_i]:
                    last_peak_i = i
                continue
        count += 1
        last_peak_i = i
    return count


def analyze_pitch(freqs, times, target_min, target_max, phrases):
    voiced = freqs > 0
    hz = freqs[voiced]
    events = []
    if len(hz) == 0:
        return {
            "voiced_pct": 0.0,
            "median_hz": None,
            "mean_hz": None,
            "p10_hz": None,
            "p90_hz": None,
            "pct_in_band": None,
            "fry_pct": None,
        }, events

    in_band = np.mean((hz >= target_min) & (hz <= target_max))

    fry_mask = (freqs > 0) & (freqs < FRY_MAX_HZ)
    fry_runs = runs_from_mask(fry_mask, times, FRY_MERGE_GAP_S, FRY_MIN_S)
    # Low-frequency periodicity during a pause is breath or room noise,
    # not fry — only report runs that overlap actual speech.
    fry_runs = [
        (t0, t1)
        for t0, t1 in fry_runs
        if any(t0 < p1 and t1 > p0 for p0, p1 in phrases)
    ]
    for t0, t1 in fry_runs:
        seg = freqs[(times >= t0) & (times <= t1) & (freqs > 0)]
        events.append(
            {
                "start_ms": int(t0 * 1000),
                "end_ms": int(t1 * 1000),
                "kind": "fry",
                "payload": {"median_hz": num(np.median(seg))},
            }
        )

    return {
        "voiced_pct": num(np.mean(voiced) * 100),
        "median_hz": num(np.median(hz)),
        "mean_hz": num(np.mean(hz)),
        "p10_hz": num(np.percentile(hz, 10)),
        "p90_hz": num(np.percentile(hz, 90)),
        "pct_in_band": num(in_band * 100),
        "fry_pct": num(np.mean(fry_mask[voiced]) * 100),
    }, events


def analyze_melody(freqs, times, phrases):
    voiced = freqs > 0
    hz = freqs[voiced]
    events = []
    if len(hz) < 10:
        return {
            "semitone_sd": None,
            "range_st_5_95": None,
            "phrase_endings": {"rising": 0, "falling": 0, "flat": 0},
        }, events

    ref = float(np.median(hz))
    st = semitones(hz, ref)
    st_all = np.full(len(freqs), np.nan)
    st_all[voiced] = st

    endings = {"rising": 0, "falling": 0, "flat": 0}
    for t0, t1 in phrases:
        sel = voiced & (times >= t0) & (times <= t1)
        if np.sum(sel) < 8:
            continue

        # Monotone stretch: a long phrase whose melodic spread is tiny.
        seg_st = st_all[sel]
        spread = float(np.percentile(seg_st, 90) - np.percentile(seg_st, 10))
        if t1 - t0 >= MONOTONE_MIN_PHRASE_S and spread < MONOTONE_MAX_RANGE_ST:
            events.append(
                {
                    "start_ms": int(t0 * 1000),
                    "end_ms": int(t1 * 1000),
                    "kind": "monotone",
                    "payload": {"range_st": num(spread)},
                }
            )

        # Phrase-final contour over the last 0.5s of voiced frames.
        tail = voiced & (times >= max(t0, t1 - 0.5)) & (times <= t1)
        if np.sum(tail) >= 4:
            tt = times[tail]
            slope = float(np.polyfit(tt, st_all[tail], 1)[0])
            delta = slope * (tt[-1] - tt[0])
            if delta > 1.0:
                endings["rising"] += 1
            elif delta < -1.0:
                endings["falling"] += 1
            else:
                endings["flat"] += 1

    return {
        "semitone_sd": num(np.std(st), 2),
        "range_st_5_95": num(np.percentile(st, 95) - np.percentile(st, 5), 2),
        "phrase_endings": endings,
    }, events


def analyze_resonance(snd, freqs, times):
    voiced_times = times[freqs > 0]
    out = {
        "f1_median_hz": None,
        "f2_median_hz": None,
        "f3_median_hz": None,
        "estimated_vtl_cm": None,
        "spectral_centroid_hz": None,
        "spectral_tilt_db": None,
    }
    if len(voiced_times) >= 10:
        formant = snd.to_formant_burg(
            time_step=TIME_STEP,
            max_number_of_formants=5,
            maximum_formant=5500.0,
            window_length=0.025,
            pre_emphasis_from=50.0,
        )
        # Plausibility windows keep tracker glitches out of the medians.
        bounds = [(200, 1200), (600, 3200), (1500, 4500)]
        tracks = ([], [], [])
        for t in voiced_times[::2]:
            for fi in range(3):
                v = formant.get_value_at_time(fi + 1, t)
                if not math.isnan(v) and bounds[fi][0] <= v <= bounds[fi][1]:
                    tracks[fi].append(v)
        medians = [float(np.median(tr)) if len(tr) >= 5 else None for tr in tracks]
        out["f1_median_hz"], out["f2_median_hz"], out["f3_median_hz"] = (
            num(medians[0]),
            num(medians[1]),
            num(medians[2]),
        )
        # Uniform-tube estimate: Fi = (2i-1)c/4L. F3 dominates the
        # average since higher formants track tract length best.
        c = 35000.0  # cm/s
        vtls = [
            (2 * i + 1) * c / (4 * medians[i]) for i in range(3) if medians[i]
        ]
        if vtls:
            out["estimated_vtl_cm"] = num(np.mean(vtls), 2)

    spectrum = snd.to_spectrum()
    out["spectral_centroid_hz"] = num(call(spectrum, "Get centre of gravity", 2))
    ltas = call(snd, "To Ltas", 100)
    low = call(ltas, "Get mean", 0, 1000, "energy")
    high = call(ltas, "Get mean", 1000, 4000, "energy")
    if not (math.isnan(low) or math.isnan(high)):
        out["spectral_tilt_db"] = num(low - high)
    return out


def analyze_breath(intensity, voiced, phrases, pauses, freqs, times):
    events = []
    phrase_durs = [t1 - t0 for t0, t1 in phrases]
    pause_durs = [t1 - t0 for t0, t1 in pauses]
    for t0, t1 in phrases:
        if t1 - t0 >= LONG_PHRASE_S:
            events.append(
                {
                    "start_ms": int(t0 * 1000),
                    "end_ms": int(t1 * 1000),
                    "kind": "long_phrase",
                    "payload": {"duration_s": num(t1 - t0)},
                }
            )

    nuclei = count_syllable_nuclei(intensity, voiced, phrases)
    phonation_s = sum(phrase_durs)
    speech_span = (phrases[-1][1] - phrases[0][0]) if phrases else 0.0

    return {
        "phrase_count": len(phrases),
        "mean_phrase_s": num(np.mean(phrase_durs), 2) if phrase_durs else None,
        "max_phrase_s": num(np.max(phrase_durs), 2) if phrase_durs else None,
        "pause_count": len(pauses),
        "mean_pause_ms": num(np.mean(pause_durs) * 1000) if pause_durs else None,
        "syllable_count": nuclei,
        "speech_rate_sps": num(nuclei / speech_span, 2) if speech_span > 0 else None,
        "articulation_rate_sps": num(nuclei / phonation_s, 2) if phonation_s > 0 else None,
    }, events


def analyze_weight(snd):
    out = {
        "cpps_db": None,
        "hnr_db": None,
        "jitter_local_pct": None,
        "shimmer_local_pct": None,
    }

    harmonicity = snd.to_harmonicity_cc(
        time_step=TIME_STEP,
        minimum_pitch=75.0,
        silence_threshold=0.1,
        periods_per_window=1.0,
    )
    voiced_frames = harmonicity.values[harmonicity.values > -100]
    if len(voiced_frames) > 0:
        out["hnr_db"] = num(np.mean(voiced_frames))

    # CPPS with the standard clinical recipe (Maryn/Praat manual).
    cepstrogram = call(snd, "To PowerCepstrogram", 60, 0.002, 5000, 50)
    cpps = call(
        cepstrogram,
        "Get CPPS",
        "yes", 0.02, 0.0005, 60, 330, 0.05,
        "Parabolic", 0.001, 0.05, "Straight", "Robust",
    )
    out["cpps_db"] = num(cpps, 2)

    point_process = call(snd, "To PointProcess (periodic, cc)", PITCH_FLOOR, PITCH_CEILING)
    jitter = call(point_process, "Get jitter (local)", 0, 0, 0.0001, 0.02, 1.3)
    shimmer = call(
        [snd, point_process], "Get shimmer (local)", 0, 0, 0.0001, 0.02, 1.3, 1.6
    )
    out["jitter_local_pct"] = num(jitter * 100, 2)
    out["shimmer_local_pct"] = num(shimmer * 100, 2)
    return out


def pitch_contour(freqs, times):
    """Median f0 per 250ms bucket — a clean trace for the detail view."""
    if len(times) == 0:
        return []
    contour = []
    n_buckets = int(times[-1] / CONTOUR_STEP_S) + 1
    for b in range(n_buckets):
        t0, t1 = b * CONTOUR_STEP_S, (b + 1) * CONTOUR_STEP_S
        seg = freqs[(times >= t0) & (times < t1) & (freqs > 0)]
        contour.append(
            {"t": num(t0, 2), "hz": num(np.median(seg)) if len(seg) else None}
        )
    return contour


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav_path")
    parser.add_argument("--target-min-hz", type=float, default=165.0)
    parser.add_argument("--target-max-hz", type=float, default=220.0)
    args = parser.parse_args()

    snd = parselmouth.Sound(args.wav_path)
    if snd.n_channels > 1:
        snd = snd.convert_to_mono()

    pitch = snd.to_pitch_ac(
        time_step=TIME_STEP,
        pitch_floor=PITCH_FLOOR,
        pitch_ceiling=PITCH_CEILING,
        voicing_threshold=VOICING_THRESHOLD,
        octave_cost=OCTAVE_COST,
    )
    freqs = pitch.selected_array["frequency"]
    times = pitch.xs()
    voiced = make_voiced_lookup(times, freqs)

    intensity = snd.to_intensity(minimum_pitch=75.0, time_step=TIME_STEP)
    phrases, pauses = detect_phrases(intensity)

    pitch_metrics, fry_events = analyze_pitch(
        freqs, times, args.target_min_hz, args.target_max_hz, phrases
    )
    melody_metrics, melody_events = analyze_melody(freqs, times, phrases)
    breath_metrics, breath_events = analyze_breath(
        intensity, voiced, phrases, pauses, freqs, times
    )
    resonance_metrics = analyze_resonance(snd, freqs, times)
    weight_metrics = analyze_weight(snd)

    events = sorted(
        fry_events + melody_events + breath_events, key=lambda e: e["start_ms"]
    )[:MAX_EVENTS]

    result = {
        "version": ANALYSIS_VERSION,
        "duration_s": num(snd.duration, 2),
        "target_min_hz": args.target_min_hz,
        "target_max_hz": args.target_max_hz,
        "pitch": pitch_metrics,
        "melody": melody_metrics,
        "resonance": resonance_metrics,
        "breath": breath_metrics,
        "weight": weight_metrics,
        "contour": pitch_contour(freqs, times),
        "events": events,
    }
    json.dump(result, sys.stdout, allow_nan=False)
    print()


if __name__ == "__main__":
    main()
