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

## What an ADTQ actually supports

Verified against a real ADTQ (firmware 1.2.1.1) on SystemAPI Server 6.10. The module
publishes actions and feedbacks based on what each device advertises, so you only see
controls the connected hardware can perform.

**Actions**

- Channel gain — set, increase/decrease (clamped to the device-reported range, −20 to +16 dB on ADTQ)
- Channel name — set
- Device name — set
- Identify device (flash the front panel)
- Reboot device

**Feedbacks**

- **Channel audio activity** — LOW / GOOD / CLIPPING, pushed by the server every 5 seconds
- Device is identifying
- Device is online

**Variables**

Device name, model, firmware, state, IP address, and per channel: name, gain and
audio activity.

## Things the Axient Digital PSM does not expose

These are not module limitations — the endpoints do not exist on the device:

- **No mute of any kind.** ADTQ channels advertise only `activity`, `gain` and `name`;
  there is no channel mute and no device audio mute. Mute actions are therefore not
  offered when connected to an ADTQ.
- **No battery data.** No ADPSM device reports a battery through SystemAPI. ADXR
  bodypacks do not appear in the device list at all, and the SBRC charger reports no
  battery capability either. Battery support is implemented (see below) and will light
  up automatically if Shure ever exposes it, but today nothing populates it.
- **No RF anything.** No frequency, RF level, antenna, transmission mode, encryption or
  ShowLink status exists in SystemAPI v1.8 for any device.

## Battery monitoring (for devices that report it)

Any device the server reports with a battery capability is tracked automatically and
numbered by name as Pack 1, Pack 2 and so on, with variables for level, charge state,
remaining runtime, health and cycle count, plus per-pack and any-pack low-battery
feedbacks and a `pack_lowest_battery` variable.

No Axient Digital PSM hardware currently reports a battery, so these stay hidden until
a battery-reporting device appears on the server.

## Developing without hardware

The repo ships a mock SystemAPI Server so the module can be developed on macOS or
Linux, where the real Windows-only server cannot run:

```
yarn mock
```

It serves the Shure-compatible API on `https://127.0.0.1:10000` and a browser control
panel on `http://127.0.0.1:10001`. Its ADTQ model mirrors the real one exactly
(capabilities, gain range, channel-id encoding), so what works against the mock works
against hardware. See `tools/mock-server/README.md`.

## Inspecting a real server

To see exactly what a SystemAPI Server exposes:

```
node tools/probe.js <server-ip> 10000 --key-file ~/.shure-api-key
```

It reports the device inventory, every device's capabilities and operation IDs, channel
details with decoded channel IDs, and a live WebSocket subscription test. Read-only
apart from opening subscriptions.
