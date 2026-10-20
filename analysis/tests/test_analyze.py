"""Ground-truth checks for analyze.py on synthetic voices.

Praat's KlattGrid synthesizes vowels with a known f0 contour and known
formants, so these tests can assert accuracy, not just shape. Run with
`just analysis-test` (inside the analysis image).
"""

import unittest

import numpy as np
import parselmouth
from parselmouth.praat import call

import analyze

RATE = 48000


def vowel(f0_points, formants, dur):
    """A KlattGrid vowel with a piecewise-linear f0 contour."""
    f1, f2, f3, f4 = formants
    kg = call("Create KlattGrid from vowel", "v", dur, 200, f1, 60, f2, 90, f3, 120, f4, 0.1, 1000)
    call(kg, "Remove pitch points between", 0, dur)
    for t, hz in f0_points:
        call(kg, "Add pitch point", t, hz)
    snd = call(kg, "To Sound")
    return snd.resample(RATE)


def silence(dur, noise_db=-70.0, seed=0):
    rng = np.random.default_rng(seed)
    amp = 10 ** (noise_db / 20)
    return parselmouth.Sound(rng.normal(0, amp, int(dur * RATE)), sampling_frequency=RATE)


def join(*parts):
    return parselmouth.Sound.concatenate(list(parts))


SCHWA_F = (580, 1750, 2900, 4000)
AH_F = (850, 1220, 2810, 4000)


def reading(f0=190.0, pause=0.5):
    """Four 'phrases' of vowels with gentle falls, separated by pauses."""
    phrases = []
    for i, formants in enumerate([SCHWA_F, AH_F, SCHWA_F, AH_F]):
        phrases.append(vowel([(0, f0 * 1.06), (1.2, f0 * 0.94)], formants, 1.2))
        if i < 3:
            phrases.append(silence(pause, seed=i))
    return join(silence(0.4, seed=9), *phrases, silence(0.4, seed=8))


class PitchAccuracy(unittest.TestCase):
    def test_median_and_band_on_known_contour(self):
        doc = analyze.analyze(reading(190.0), 165, 220)
        self.assertAlmostEqual(doc["pitch"]["median_hz"], 190.0, delta=190 * 0.01)
        self.assertGreater(doc["pitch"]["pct_in_band"], 99.0)
        self.assertEqual(doc["pitch"]["fry_pct"], 0.0)
        self.assertEqual([e for e in doc["events"] if e["kind"] == "fry"], [])

    def test_out_of_band_voice(self):
        doc = analyze.analyze(reading(140.0), 165, 220)
        self.assertAlmostEqual(doc["pitch"]["median_hz"], 140.0, delta=140 * 0.01)
        self.assertLess(doc["pitch"]["pct_in_band"], 1.0)

    def test_contour_follows_glide(self):
        # KlattGrid interpolates f0 linearly in Hz: 150 -> 300 over 2 s.
        snd = join(silence(0.3), vowel([(0, 150), (2.0, 300)], SCHWA_F, 2.0), silence(0.3))
        doc = analyze.analyze(snd)
        pts = [(p["t"], p["hz"]) for p in doc["contour"] if p["hz"] is not None and 0.6 <= p["t"] <= 2.0]
        self.assertGreater(len(pts), 4)
        slope = np.polyfit([t for t, _ in pts], [hz for _, hz in pts], 1)[0]
        self.assertAlmostEqual(slope, 75.0, delta=75.0 * 0.05)
        hz = [h for _, h in pts]
        self.assertEqual(hz, sorted(hz))

    def test_fry_stretch_is_an_event(self):
        snd = join(
            silence(0.3),
            vowel([(0, 190), (1.0, 180)], SCHWA_F, 1.0),
            vowel([(0, 75), (0.5, 70)], SCHWA_F, 0.5),
            silence(0.3),
        )
        doc = analyze.analyze(snd)
        fry = [e for e in doc["events"] if e["kind"] == "fry"]
        self.assertEqual(len(fry), 1)
        self.assertAlmostEqual(fry[0]["start_ms"], 1300, delta=80)


class HumAndPauses(unittest.TestCase):
    def test_mains_hum_in_pauses_is_not_fry(self):
        base = reading(190.0, pause=0.8)
        t = np.arange(base.values.shape[1]) / RATE
        hum = 0.004 * np.sin(2 * np.pi * 60 * t) + 0.002 * np.sin(2 * np.pi * 120 * t)
        hummed = parselmouth.Sound(base.values[0] + hum, sampling_frequency=RATE)
        doc = analyze.analyze(hummed, 165, 220)
        self.assertLess(doc["pitch"]["fry_pct"], 0.5)

    def test_voice_measures_ignore_pause_length(self):
        short = analyze.analyze(reading(190.0, pause=0.3))
        long = analyze.analyze(reading(190.0, pause=2.0))
        for section, key, tol in [
            ("weight", "cpps_db", 0.5),
            ("weight", "hnr_db", 0.5),
            ("resonance", "spectral_centroid_hz", 15),
            ("resonance", "spectral_tilt_db", 0.5),
        ]:
            with self.subTest(key=key):
                self.assertIsNotNone(short[section][key])
                self.assertAlmostEqual(short[section][key], long[section][key], delta=tol)


class Formants(unittest.TestCase):
    def test_known_formants(self):
        for formants in (SCHWA_F, AH_F, (310, 2790, 3310, 4200)):
            with self.subTest(formants=formants):
                snd = join(silence(0.3), vowel([(0, 200), (1.5, 185)], formants, 1.5), silence(0.3))
                doc = analyze.analyze(snd)
                r = doc["resonance"]
                got = (r["f1_median_hz"], r["f2_median_hz"], r["f3_median_hz"])
                # LPC pulls a low F1 toward the nearest harmonic when f0 is
                # high (here /i/: 310 Hz F1 under a ~190 Hz voice reads
                # ~370), a known limit of formant tracking on higher voices.
                tolerance = (0.2, 0.06, 0.06)
                for g, want, tol in zip(got, formants, tolerance):
                    self.assertAlmostEqual(g, want, delta=want * tol)

    def test_uniform_tube_length(self):
        # A 15 cm uniform tube resonates at (2i-1) * c / 4L.
        length = 15.0
        f = [(2 * i - 1) * 35000 / (4 * length) for i in (1, 2, 3, 4)]
        snd = join(silence(0.3), vowel([(0, 180), (1.5, 170)], f, 1.5), silence(0.3))
        doc = analyze.analyze(snd)
        self.assertAlmostEqual(doc["resonance"]["estimated_vtl_cm"], length, delta=0.5)


class Robustness(unittest.TestCase):
    def test_silence_only(self):
        doc = analyze.analyze(silence(2.0))
        self.assertIsNone(doc["pitch"]["median_hz"])
        self.assertIsNone(doc["weight"]["cpps_db"])

    def test_document_is_json_safe(self):
        import json

        json.dumps(analyze.analyze(reading()), allow_nan=False)


if __name__ == "__main__":
    unittest.main()


class BatchMode(unittest.TestCase):
    def test_jsonl_reports_each_file_and_survives_a_bad_one(self):
        import json
        import os
        import subprocess
        import sys
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            good = os.path.join(tmp, "good.wav")
            reading(190.0).save(good, "WAV")
            bad = os.path.join(tmp, "bad.wav")
            with open(bad, "wb") as f:
                f.write(b"not a wav")
            script = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "analyze.py")
            out = subprocess.run(
                [sys.executable, script, "--jsonl", "--target-min-hz", "165", "--target-max-hz", "220", good, bad, good],
                capture_output=True, text=True, check=True,
            ).stdout.strip().splitlines()
        docs = [json.loads(line) for line in out]
        self.assertEqual([d["file"] for d in docs], [good, bad, good])
        self.assertAlmostEqual(docs[0]["pitch"]["median_hz"], 190.0, delta=2)
        self.assertIn("error", docs[1])
        self.assertEqual(docs[0], docs[2])
