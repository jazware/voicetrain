// Package wav parses just enough of the RIFF/WAVE format to validate
// uploads and derive recording metadata. It is not a decoder.
package wav

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Info describes a PCM WAV file's audio parameters.
type Info struct {
	SampleRate    int
	Channels      int
	BitsPerSample int
	DataBytes     int64
	DurationMs    int64
}

var ErrNotWAV = errors.New("not a PCM WAV file")

// Parse walks the RIFF chunks of r and returns the format info.
// Only uncompressed PCM (format 1) is accepted.
func Parse(r io.Reader) (*Info, error) {
	var header [12]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, fmt.Errorf("%w: short header", ErrNotWAV)
	}
	if string(header[0:4]) != "RIFF" || string(header[8:12]) != "WAVE" {
		return nil, fmt.Errorf("%w: missing RIFF/WAVE magic", ErrNotWAV)
	}

	info := &Info{}
	haveFmt := false
	for {
		var chunkHeader [8]byte
		if _, err := io.ReadFull(r, chunkHeader[:]); err != nil {
			if haveFmt && info.DataBytes > 0 {
				break
			}
			return nil, fmt.Errorf("%w: truncated chunks", ErrNotWAV)
		}
		chunkID := string(chunkHeader[0:4])
		chunkSize := int64(binary.LittleEndian.Uint32(chunkHeader[4:8]))

		switch chunkID {
		case "fmt ":
			var fmtChunk [16]byte
			if chunkSize < 16 {
				return nil, fmt.Errorf("%w: fmt chunk too small", ErrNotWAV)
			}
			if _, err := io.ReadFull(r, fmtChunk[:]); err != nil {
				return nil, fmt.Errorf("%w: truncated fmt chunk", ErrNotWAV)
			}
			audioFormat := binary.LittleEndian.Uint16(fmtChunk[0:2])
			if audioFormat != 1 {
				return nil, fmt.Errorf("%w: audio format %d is not PCM", ErrNotWAV, audioFormat)
			}
			info.Channels = int(binary.LittleEndian.Uint16(fmtChunk[2:4]))
			info.SampleRate = int(binary.LittleEndian.Uint32(fmtChunk[4:8]))
			info.BitsPerSample = int(binary.LittleEndian.Uint16(fmtChunk[14:16]))
			if info.Channels <= 0 || info.SampleRate <= 0 || info.BitsPerSample <= 0 {
				return nil, fmt.Errorf("%w: invalid fmt parameters", ErrNotWAV)
			}
			haveFmt = true
			if err := skip(r, chunkSize-16+chunkSize%2); err != nil {
				return nil, err
			}
		case "data":
			if !haveFmt {
				return nil, fmt.Errorf("%w: data chunk before fmt", ErrNotWAV)
			}
			info.DataBytes = chunkSize
			byteRate := int64(info.SampleRate) * int64(info.Channels) * int64(info.BitsPerSample/8)
			info.DurationMs = chunkSize * 1000 / byteRate
			return info, nil
		default:
			// Chunks are word-aligned; odd sizes carry a pad byte.
			if err := skip(r, chunkSize+chunkSize%2); err != nil {
				return nil, err
			}
		}
	}
	return info, nil
}

func skip(r io.Reader, n int64) error {
	if n <= 0 {
		return nil
	}
	if _, err := io.CopyN(io.Discard, r, n); err != nil {
		return fmt.Errorf("%w: truncated chunk", ErrNotWAV)
	}
	return nil
}
