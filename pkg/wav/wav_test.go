package wav

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

// buildWAV constructs a minimal PCM WAV file in memory.
func buildWAV(sampleRate, channels, bits int, dataBytes int, extraChunk bool) []byte {
	var buf bytes.Buffer
	write := func(v any) { binary.Write(&buf, binary.LittleEndian, v) }

	buf.WriteString("RIFF")
	write(uint32(0)) // size, unchecked
	buf.WriteString("WAVE")

	if extraChunk {
		buf.WriteString("LIST")
		write(uint32(5)) // odd size to exercise pad-byte handling
		buf.Write([]byte{1, 2, 3, 4, 5, 0})
	}

	buf.WriteString("fmt ")
	write(uint32(16))
	write(uint16(1)) // PCM
	write(uint16(channels))
	write(uint32(sampleRate))
	write(uint32(sampleRate * channels * bits / 8))
	write(uint16(channels * bits / 8))
	write(uint16(bits))

	buf.WriteString("data")
	write(uint32(dataBytes))
	buf.Write(make([]byte, dataBytes))
	return buf.Bytes()
}

func TestParse(t *testing.T) {
	// 2 seconds of 48kHz mono 16-bit: 192000 bytes.
	data := buildWAV(48000, 1, 16, 192000, false)
	info, err := Parse(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if info.SampleRate != 48000 || info.Channels != 1 || info.BitsPerSample != 16 {
		t.Errorf("format wrong: %+v", info)
	}
	if info.DurationMs != 2000 {
		t.Errorf("duration: want 2000ms, got %d", info.DurationMs)
	}
}

func TestParseSkipsUnknownChunks(t *testing.T) {
	data := buildWAV(44100, 2, 16, 44100*2*2, true)
	info, err := Parse(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("parse with LIST chunk: %v", err)
	}
	if info.DurationMs != 1000 {
		t.Errorf("duration: want 1000ms, got %d", info.DurationMs)
	}
}

func TestParseRejectsGarbage(t *testing.T) {
	cases := map[string][]byte{
		"empty":     {},
		"not riff":  []byte("OGGSxxxxxxxxxxxxxxxxxxxx"),
		"truncated": buildWAV(48000, 1, 16, 1000, false)[:20],
	}
	for name, data := range cases {
		if _, err := Parse(bytes.NewReader(data)); !errors.Is(err, ErrNotWAV) {
			t.Errorf("%s: want ErrNotWAV, got %v", name, err)
		}
	}
}

func TestParseRejectsNonPCM(t *testing.T) {
	data := buildWAV(48000, 1, 16, 1000, false)
	// Patch audio format to 3 (IEEE float).
	data[20] = 3
	if _, err := Parse(bytes.NewReader(data)); !errors.Is(err, ErrNotWAV) {
		t.Errorf("float wav: want ErrNotWAV, got %v", err)
	}
}
