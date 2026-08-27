# companion-module-shure-systemapi

Companion module for Shure devices reached through the **Shure SystemAPI Server**,
including Axient Digital PSM (ADTQ/ADTD), which has no other control protocol.

See HELP.md and LICENSE for more information about this module.

## Development

```bash
yarn install
yarn mock     # local mock SystemAPI server + simulator UI, for working without hardware
```

`tools/probe.js` reports exactly what a real SystemAPI Server exposes:

```bash
node tools/probe.js <server-ip> 10000 --key-file ~/.shure-api-key
```
