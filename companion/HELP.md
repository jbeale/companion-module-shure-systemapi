# Shure Axient Digital PSM (ADTQ/ADTD)

This module controls Shure Axient Digital PSM in-ear monitoring transmitters (ADTQ and ADTD).

## Requirements — please read first

Unlike Shure's older wireless products (ULX-D, QLX-D, AD4, PSM1000), the Axient Digital PSM transmitters do **not** offer a direct TCP command-string interface. Shure only exposes third-party control through their **SystemAPI Server** application:

- Download SystemAPI Server (**version 6.5.0 or later** — the version that added ADTQ/ADTD support) from [shure.com](https://www.shure.com/en-US/products/software/systemapi).
- It runs on **Windows** (10/11 or Server 2016+) on the same network as your transmitters.
- During installation you will be given a **shared secret API key** — this module needs it.
- Companion connects to the SystemAPI Server, which relays control to the transmitters.

## Configuration

| Setting                  | Description                                               |
| ------------------------ | --------------------------------------------------------- |
| SystemAPI Server IP/Host | Address of the machine running SystemAPI Server           |
| SystemAPI Server Port    | The web server port chosen during install (default 10000) |
| API Key                  | The shared secret from the SystemAPI Server installation  |
| Device Selection         | Auto (first ADTQ/ADTD found) or a specific device ID      |

All ADTQ/ADTD units discovered by the server are listed with their device IDs in the connection debug log, so you can copy the ID of the unit you want into the Device ID field. Add one connection per transmitter to control several.

## Actions

- Channel mute / unmute / toggle
- Channel gain set / increase / decrease (clamped to the device-reported range)
- Channel name set
- Device audio mute
- Identify device (flash front panel)
- Device name set
- Reboot device

## Feedbacks

- **Any pack battery below threshold** — the one to put on a button for low-battery alerts
- **Pack battery below threshold** — per pack, optionally also triggering when that pack goes offline
- **Pack is charging**
- Channel is muted
- Device audio is muted
- Device is identifying
- Device is online

## Battery monitoring

Every battery-reporting device the server knows about (ADXR bodypacks) is tracked
automatically and numbered by name as Pack 1, Pack 2, and so on. No configuration is
needed — add packs to the network and they appear.

Per pack: `pack_N_name`, `pack_N_model`, `pack_N_battery`, `pack_N_battery_state`
(CHARGING / DISCHARGING / FULL / EMPTY / CALCULATING / OPTIMAL_STORAGE),
`pack_N_runtime` (H:MM remaining), `pack_N_runtime_minutes`, `pack_N_health`,
`pack_N_cycles` and `pack_N_state`.

Across all packs: `pack_count` and `pack_lowest_battery` — the latter is handy on a
single "worst pack on stage" button.

## Variables

Device name, model, firmware, state, IP address, per-channel name/mute/gain, and the
pack battery variables above.

## Developing without hardware

The repo ships a mock SystemAPI Server so the module can be developed on macOS or
Linux, where the real Windows-only server cannot run:

```
yarn mock
```

It serves the Shure-compatible API on `https://127.0.0.1:10000` and a browser control
panel on `http://127.0.0.1:10001` for creating transmitters and packs and driving
battery levels, mute, gain and activity in real time. See `tools/mock-server/README.md`.

## Known limitations

Shure's SystemAPI (v1.8) exposes **no RF-related endpoints at all** — RF mute/power,
frequency, transmission mode, encryption status and ShowLink status are not available
through the API for any device. The closest available signal is per-channel audio
activity (LOW / GOOD / CLIPPING). If Shure adds RF capabilities in a future SystemAPI
release they can be added here.

Whether ADXR bodypacks appear as devices on the SystemAPI Server has not yet been
confirmed against real hardware — Shure's release notes list only ADTD/ADTQ for
Axient Digital PSM. If packs turn out to only be visible while docked in an SBC441
charger, the battery features will reflect that.
