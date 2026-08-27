# Mock Shure SystemAPI Server

A local stand-in for Shure's SystemAPI Server so this module can be developed and
tested on macOS or Linux. The real server is Windows-only, and its device layer is
a native Windows daemon (`ShureDeviceManager.exe`), so it cannot be run here at all.

```bash
yarn mock
```

```
  Shure SystemAPI (mock)   https://127.0.0.1:10000/api/v1
  API key                  mock-shure-api-key
  Simulator control panel  http://127.0.0.1:10001
```

Point a Companion connection at `127.0.0.1`, port `10000`, with that API key, then
open the control panel to create devices and drive their state.

## Options

| Flag           | Default              | Meaning                                                           |
| -------------- | -------------------- | ----------------------------------------------------------------- |
| `--port`       | `10000`              | HTTPS port for the Shure-compatible API                           |
| `--ui-port`    | `10001`              | HTTP port for the simulator control panel                         |
| `--key`        | `mock-shure-api-key` | Value required in the `x-api-key` header                          |
| `--list-shape` | `paginated`          | `GET /v1/devices` response shape: `paginated`, `array` or `items` |

`--list-shape` exists because the spec's `ListDevicesResponse` is Relay-style
pagination (`{pageInfo, edges:[{cursor,node}]}`) while Shure's Getting Started guide
shows a bare array. The module accepts all three; use this flag to prove it.

## What is simulated

Faithful to the SystemAPI v1.8 schemas:

- **Devices** — ADTQ (4 channel) and ADTD (2 channel) transmitters, ADXR bodypack
  receivers ("packs"). Online/offline transitions emit `DEVICE_STATE_CHANGE`.
- **Battery** — level percentage, charge state, time-to-target as an ISO-8601
  duration, health percentage and cycle count, emitting `DEVICE_BATTERY_LEVEL`
  and `DEVICE_BATTERY_HEALTH`. Enable **Run** on a pack to drain or charge it in
  real time so low-battery feedbacks can be watched firing.
- **Audio channels** — mute, gain (with a device-reported range), name, and
  activity level, emitting the matching `AUDIO_CHANNEL_*` events. Activity is
  re-emitted every 5 seconds, matching the real server's documented cadence.
- **Device** — name, identify start/stop, device audio mute, reboot.
- **Transport** — HTTPS with a generated self-signed certificate (as the real
  server uses by default), `x-api-key` auth, and the
  `wss://…/v1/subscriptions/websocket/create` → `transportId` → per-capability
  subscription handshake.

Audio channel IDs are base64-encoded JSON carrying the channel index, exactly as
the real server encodes them, so the module's decoding path is exercised.

## What is not simulated

**RF and signal quality do not exist in SystemAPI v1.8.** There is no endpoint for
frequency, RF level, antenna status, transmission mode, encryption or ShowLink —
for any device, not just ADPSM. Nothing here invents them, because the module could
never consume them against a real server. The nearest real signal is per-channel
audio activity (`LOW` / `GOOD` / `CLIPPING`).

## Caveats to verify against real hardware

These are informed guesses that only an ADTQ on a real SystemAPI Server can settle:

- **Pack visibility (still open).** A real rig scanned on 2026-08-27 showed no ADXR and
  no battery capability anywhere — but all packs were powered off, so it proved nothing.
  Re-scan with packs on using `--snapshot` / `--diff`.
  Whether ADXR bodypacks appear in `GET /v1/devices` at all:
  Shure's 6.5.0 release notes list only ADTD/ADTQ for Axient Digital PSM, and for
  ULX-D they note that transmitters are only reachable while docked in a charger —
  so packs may only appear when docked, or may not appear at all. If they do not,
  battery data would have to come from an SBC441 charger instead.
- **Capability names.** `battery-level` and `battery-health` are inferred from the
  endpoint paths. The module tolerates a mismatch (it requests battery data and
  ignores failures) but the capability filter used to find packs would need updating.
- **Channel capabilities.** Which of `mute` / `gain` / `name` a real ADTQ channel
  actually advertises.
