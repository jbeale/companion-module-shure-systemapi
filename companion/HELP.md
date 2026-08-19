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

- Channel is muted
- Device audio is muted
- Device is identifying
- Device is online

## Variables

Device name, model, firmware, state, IP address, and per-channel name/mute/gain.

## Known limitations

Shure's SystemAPI does not currently expose RF-related features for these devices — RF mute/power, frequency, transmission mode, encryption status, and ShowLink status are not available through the API. If Shure adds these capabilities in a future SystemAPI release, they can be added to this module.
