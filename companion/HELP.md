# Shure SystemAPI

Monitor and control Shure devices through the **Shure SystemAPI Server**.

One Companion connection controls one device. Actions, feedbacks and variables are
built from the capabilities that device reports, so the same module serves an Axient
Digital PSM transmitter, an ANX4 receiver, a bodypack or a networked charger with no
model-specific configuration.

## Which Shure module should I use?

| If you have | Use |
| --- | --- |
| **Axient Digital PSM (ADTQ / ADTD)** | **This module** — these have no other control protocol at all |
| A device only SystemAPI supports, or you already run SystemAPI | This module |
| ULX-D, QLX-D, SLX-D, Axient Digital receivers | `shure-wireless` — direct TCP, no middleware, and it exposes RF data this API does not |
| MXA microphones, P300, MXN, chargers | The existing dedicated Shure modules |

SystemAPI is a Windows application sitting between Companion and your gear. That is a
real operational cost, and it is worth paying when it is the only option — as it is for
Axient Digital PSM — or when the server is already part of your system.

## Requirements

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
| Device                   | Which transmitter this connection controls                |

**Picking your device.** Because a rack usually holds several identical transmitters,
the Device list shows each one by name, model and IP — for example
`ADTQ  "ADTQ B"  192.168.10.117` — so you can pick the right unit without hunting for a
UUID.

The list is filled in from the server, so on a brand new connection it starts with just
"Auto". Enter the address and API key, **save, then reopen the config page** and your
devices will be listed. A device ID can also be typed in directly if you prefer.

Add one connection per transmitter to control several. Every device on the server is
offered, not just ADTQ/ADTD — the available actions adapt to whatever the selected
device reports it can do.

## What you get depends on the device

The module publishes only what the selected device advertises. Two devices on the same
server can therefore offer different controls — verified on real hardware:

| | ADTQ (Axient Digital PSM) | ANX4 (receiver) |
| --- | --- | --- |
| Channels | 4 | 12 |
| Channel capabilities | `activity, gain, name` | `activity, gain, mute, name` |
| Channel mute action | not offered | offered |

Below is what an ADTQ supports, verified against firmware 1.2.1.1 on SystemAPI Server 6.10.

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

These are not module limitations — the endpoints do not exist on that device. Other
devices on the same server may well expose them (an ANX4's channels have mute, for
instance):

- **No mute of any kind.** ADTQ channels advertise only `activity`, `gain` and `name`;
  there is no channel mute and no device audio mute. Mute actions are therefore not
  offered when connected to an ADTQ.
- **Battery data: not yet confirmed either way.** In the one rig scanned so far
  (4x ADTQ, 2x AD8C, ANX4, SBRC) no device advertised a battery capability and no ADXR
  bodypack appeared in the device list — but **every pack was powered off at the time**,
  so that scan cannot distinguish "the API never exposes packs" from "there were no packs
  to see". Re-testing with packs powered on (and docked in the SBRC) is the open task;
  `tools/probe.js --snapshot` / `--diff` exists to make that comparison conclusive.
- **No RF anything.** No frequency, RF level, antenna, transmission mode, encryption or
  ShowLink status exists in SystemAPI v1.8 for any device.

## Battery monitoring (for devices that report it)

Any device the server reports with a battery capability is tracked automatically and
numbered by name as Pack 1, Pack 2 and so on, with variables for level, charge state,
remaining runtime, health and cycle count, plus per-pack and any-pack low-battery
feedbacks and a `pack_lowest_battery` variable.

These stay hidden until a battery-reporting device appears on the server. Whether ADPSM
bodypacks ever do is still unverified — see above.

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
