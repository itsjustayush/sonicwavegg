# Sonic Morse Format 01

Sonic Morse is a browser-first, short-payload acoustic link designed for deliberate nearby exchange rather than bulk transfer. The protocol is custom-built for this project and does not wrap ggwave. It uses four simultaneous 16-ary FSK tone groups, so each symbol carries two bytes. The codec generates the waveform locally with the Web Audio API and analyzes microphone samples locally in the browser.

| Property | Design choice |
| --- | --- |
| Symbol capacity | Four 4-bit FSK groups, equal to 16 bits or two bytes per symbol |
| Frequency bands | Audible: 1.7–6.8 kHz; near-ultrasonic: 14.5–19.8 kHz |
| Framing | Three preamble chords, one sync chord, then packet symbols; the receiver locks directly to the sync chord and refines its symbol timing before reading payload |
| Packet | Magic byte, sequence, UTF-8 payload length, payload, CRC-8, XOR parity, modular-sum parity |
| Redundancy | CRC-8 plus dual parity for integrity detection; invalid frames are rejected rather than displayed |
| Profiles | Robust: 52 ms symbols; Balanced: 32 ms; Turbo: 24 ms |
| Fast-path target | A 12-byte message encodes as an 18-byte packet or nine payload symbols. At Balanced, total modulation time including framing is about 416 ms; at Turbo, about 312 ms. |

The design deliberately prioritizes short-message speed. Its Balanced profile targets approximately 62.5 raw bytes per second and Turbo approximately 83.3 raw bytes per second, before framing and redundancy. The receiver searches for the sync chord at sub-symbol intervals, refines its timing lock around the strongest candidate, tolerates small carrier offsets, and gates weak candidates against a measured noise floor. The actual usable rate and distance still vary with devices, microphone processing, room acoustics, volume, orientation, and selected frequency band. A production deployment should calibrate against representative hardware and should retain an in-app QR or copy/paste fallback.

The protocol is not an authorization mechanism. Packets are observable and replayable by nearby listeners. Security-sensitive use cases must add a signed, expiring, nonce-bearing application payload before encoding.
