#!/usr/bin/env node
/**
 * Probe a real Shure SystemAPI Server and report exactly what it exposes.
 *
 * Answers the questions that only real hardware can settle: the device list
 * response shape, which devices appear, what capability strings they advertise,
 * whether bodypacks are visible, and which endpoints actually respond.
 *
 * Usage:
 *   SHURE_API_KEY=... node tools/probe.js <host> [port]
 *   node tools/probe.js <host> [port] --key-file /path/to/key.txt
 *
 * Record a baseline, then compare a later scan against it (e.g. before and
 * after powering bodypacks on) to see exactly what appeared:
 *   node tools/probe.js <host> --key-file <k> --snapshot baseline.json
 *   node tools/probe.js <host> --key-file <k> --diff baseline.json
 */

import https from 'node:https'
import fs from 'node:fs'
import WebSocket from 'ws'

const argv = process.argv.slice(2)
const host = argv.find((a) => !a.startsWith('--')) ?? '127.0.0.1'
const port = Number(argv.filter((a) => !a.startsWith('--'))[1] ?? 10000)

const keyFileFlag = argv.indexOf('--key-file')
const apiKey =
	keyFileFlag !== -1 ? fs.readFileSync(argv[keyFileFlag + 1], 'utf8').trim() : (process.env.SHURE_API_KEY ?? '')

if (!apiKey) {
	console.error('No API key. Set SHURE_API_KEY or pass --key-file <path>.')
	process.exit(1)
}

/**
 * One REST call against the server.
 *
 * @param {string} method - HTTP method
 * @param {string} path - path below /api
 * @param {Object} [body] - optional JSON body
 * @returns {Promise<{status:number, body:any, raw:string}>} response
 */
function req(method, path, body) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body)
		const r = https.request(
			{
				host,
				port,
				path: `/api${path}`,
				method,
				rejectUnauthorized: false,
				timeout: 8000,
				headers: {
					'x-api-key': apiKey,
					// the server rejects application/json with an empty body, so only
					// declare a content type when there actually is one
					...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
				},
			},
			(res) => {
				let d = ''
				res.on('data', (c) => (d += c))
				res.on('end', () => {
					let parsed = null
					try {
						parsed = d.length ? JSON.parse(d) : null
					} catch (_e) {
						/* leave raw */
					}
					resolve({ status: res.statusCode, body: parsed, raw: d })
				})
			},
		)
		r.on('error', reject)
		r.on('timeout', () => r.destroy(new Error('timeout')))
		payload ? r.end(payload) : r.end()
	})
}

const line = (s = '') => console.log(s)
const rule = (t) => line(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`)

/**
 * Normalise the device list across the three possible response shapes.
 * @param {any} b - response body
 * @returns {{shape:string, nodes:Array}} shape name and nodes
 */
function normalise(b) {
	if (Array.isArray(b)) return { shape: 'bare array', nodes: b }
	if (Array.isArray(b?.edges)) return { shape: 'paginated (pageInfo/edges/node)', nodes: b.edges.map((e) => e.node) }
	if (Array.isArray(b?.items)) return { shape: 'items wrapper', nodes: b.items }
	return { shape: 'UNKNOWN', nodes: [] }
}

rule(`Shure SystemAPI probe — ${host}:${port}`)

const devicesRes = await req('GET', '/v1/devices')
line(`GET /v1/devices -> HTTP ${devicesRes.status}`)
if (devicesRes.status !== 200) {
	line(devicesRes.raw.slice(0, 400))
	process.exit(1)
}

const { shape, nodes } = normalise(devicesRes.body)
line(`Response shape: ${shape}`)
line(`Devices found: ${nodes.length}`)

rule('DEVICE INVENTORY')
for (const n of nodes) {
	const hw = n.hardwareIdentity ?? {}
	const sw = n.softwareIdentity ?? {}
	line(`\n${sw.model ?? '?'}  "${hw.deviceId ?? '?'}"`)
	line(
		`  state=${n.deviceState}  compat=${n.compatibility}  fw=${sw.firmwareVersion ?? '-'}  sn=${hw.serialNumber ?? '-'}`,
	)
	line(`  address=${n.communicationProtocol?.address ?? '-'}  protocol=${n.communicationProtocol?.name ?? '-'}`)
	line(`  capabilities (${n.capabilities?.length ?? 0}): ${(n.capabilities ?? []).join(', ') || '(none listed)'}`)
}

// --------------------------------------------------------------- snapshot/diff

const snapFlag = argv.indexOf('--snapshot')
const diffFlag = argv.indexOf('--diff')

/**
 * Reduce the inventory to the fields worth comparing between runs.
 * @param {Array} list - device nodes
 * @returns {Array<Object>} comparable records
 */
function snapshotOf(list) {
	return list
		.map((n) => ({
			deviceId: n.hardwareIdentity?.deviceId,
			model: n.softwareIdentity?.model,
			serial: n.hardwareIdentity?.serialNumber,
			state: n.deviceState,
			address: n.communicationProtocol?.address,
			capabilities: [...(n.capabilities ?? [])].sort(),
		}))
		.sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId)))
}

const current = snapshotOf(nodes)

if (diffFlag !== -1) {
	rule('DIFF AGAINST BASELINE')
	const baselinePath = argv[diffFlag + 1]
	const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
	const byId = (arr) => new Map(arr.map((d) => [d.deviceId, d]))
	const before = byId(baseline)
	const after = byId(current)

	const added = current.filter((d) => !before.has(d.deviceId))
	const removed = baseline.filter((d) => !after.has(d.deviceId))

	line(`baseline: ${baseline.length} devices   now: ${current.length} devices\n`)

	if (added.length) {
		line(`NEW DEVICES (${added.length}):`)
		for (const d of added) {
			line(`  + ${d.model}  ${d.deviceId}  ${d.state}  ${d.address ?? ''}  sn=${d.serial ?? '-'}`)
			line(`      capabilities: ${d.capabilities.join(', ') || '(none)'}`)
			const batt = d.capabilities.filter((c) => /batt/i.test(c))
			if (batt.length) line(`      *** BATTERY CAPABILITY: ${batt.join(', ')} ***`)
		}
	} else {
		line('NEW DEVICES: none')
	}

	if (removed.length) {
		line(`\nDEVICES GONE (${removed.length}):`)
		for (const d of removed) line(`  - ${d.model}  ${d.deviceId}`)
	}

	line('\nCHANGED:')
	let changes = 0
	for (const d of current) {
		const b = before.get(d.deviceId)
		if (!b) continue
		const notes = []
		if (b.state !== d.state) notes.push(`state ${b.state} -> ${d.state}`)
		const gained = d.capabilities.filter((c) => !b.capabilities.includes(c))
		const lost = b.capabilities.filter((c) => !d.capabilities.includes(c))
		if (gained.length) notes.push(`gained [${gained.join(', ')}]`)
		if (lost.length) notes.push(`lost [${lost.join(', ')}]`)
		if (notes.length) {
			changes++
			line(`  ~ ${d.model} ${d.deviceId}: ${notes.join('; ')}`)
		}
	}
	if (!changes) line('  (no state or capability changes)')

	const anyBattery = current.some((d) => d.capabilities.some((c) => /batt/i.test(c)))
	line(
		`\nVERDICT: ${anyBattery ? 'battery-reporting device(s) PRESENT' : 'still no battery-reporting device on the server'}`,
	)
}

if (snapFlag !== -1) {
	const out = argv[snapFlag + 1]
	fs.writeFileSync(out, JSON.stringify(current, null, 2))
	line(`\nSnapshot of ${current.length} devices written to ${out}`)
}

rule('PER-DEVICE ENDPOINT SUPPORT')
const probes = [
	['GET', 'capabilities'],
	['GET', 'name'],
	['GET', 'identify'],
	['GET', 'audio-mute'],
	['GET', 'battery-level'],
	['GET', 'battery-health'],
	['GET', 'audio-channels'],
	['GET', 'audio-channels-v2'],
	['GET', 'uptime'],
	['GET', 'user-presets'],
]

for (const n of nodes) {
	const id = n.hardwareIdentity?.deviceId
	if (!id) continue
	line(`\n--- ${n.softwareIdentity?.model} (${id}) ---`)

	for (const [method, ep] of probes) {
		const r = await req(method, `/v1/devices/${id}/${ep}`)
		const ok = r.status >= 200 && r.status < 300
		let summary = ''
		if (ok && r.body !== null) {
			summary = JSON.stringify(r.body)
			if (summary.length > 220) summary = summary.slice(0, 220) + '…'
		}
		line(`  ${String(r.status).padEnd(4)} ${ep.padEnd(18)} ${ok ? summary : (r.body?.title ?? '').slice(0, 60)}`)
	}

	// channel detail
	const ch = await req('GET', `/v1/devices/${id}/audio-channels`)
	const chans = Array.isArray(ch.body) ? ch.body : (ch.body?.items ?? [])
	if (chans.length) {
		line(`  audio channels: ${chans.length}`)
		for (const c of chans.slice(0, 8)) {
			let decoded = ''
			try {
				decoded = JSON.stringify(JSON.parse(Buffer.from(c.id, 'base64').toString('utf8')))
			} catch (_e) {
				decoded = '(id is not base64 JSON)'
			}
			line(`    role=${c.role} group=${c.group} caps=[${(c.capabilities ?? []).join(',')}]`)
			line(`      id decodes to: ${decoded}`)
			for (const ep of ['mute', 'gain', 'name', 'activity']) {
				const r = await req('GET', `/v1/devices/${id}/audio-channels/${encodeURIComponent(c.id)}/${ep}`)
				line(`      ${String(r.status).padEnd(4)} ${ep.padEnd(9)} ${r.status < 300 ? JSON.stringify(r.body) : ''}`)
			}
			const gd = await req('GET', `/v1/devices/${id}/audio-channels/${encodeURIComponent(c.id)}/gain/description`)
			line(`      ${String(gd.status).padEnd(4)} gain/desc ${gd.status < 300 ? JSON.stringify(gd.body) : ''}`)
		}
	}
}

rule('WEBSOCKET SUBSCRIPTION TEST')
await new Promise((resolve) => {
	const ws = new WebSocket(`wss://${host}:${port}/api/v1/subscriptions/websocket/create`, { rejectUnauthorized: false })
	const events = []
	let transportId = null

	const done = () => {
		line(`\nEvents received in 12s: ${events.length}`)
		for (const e of events.slice(0, 25)) {
			line(`  ${e.envelope?.eventName?.padEnd(26)} ${JSON.stringify(e.body).slice(0, 130)}`)
		}
		const names = [...new Set(events.map((e) => e.envelope?.eventName))]
		if (names.length) line(`\nDistinct event types: ${names.join(', ')}`)
		try {
			ws.close()
		} catch (_e) {
			/* ignore */
		}
		resolve()
	}

	ws.on('error', (e) => {
		line(`WebSocket error: ${e.message}`)
		resolve()
	})

	ws.on('message', async (raw) => {
		let m
		try {
			m = JSON.parse(raw.toString())
		} catch (_e) {
			return
		}

		if (m.transportId && !transportId) {
			transportId = m.transportId
			line(`transportId received: ${transportId}`)

			const subs = [`/v1/devices/subscription/${transportId}`]
			for (const n of nodes) {
				const id = n.hardwareIdentity?.deviceId
				if (!id) continue
				for (const ep of ['name', 'identify', 'audio-mute', 'battery-level', 'battery-health']) {
					subs.push(`/v1/devices/${id}/${ep}/subscription/${transportId}`)
				}
			}

			let ok = 0
			const failures = new Map()
			for (const p of subs) {
				const r = await req('POST', p)
				if (r.status < 300) ok++
				else failures.set(p.split('/').slice(4, 5).join('') || p, r.status)
			}
			line(`Subscriptions accepted: ${ok}/${subs.length}`)
			if (failures.size) {
				line('Rejected subscription targets:')
				for (const [k, v] of failures) line(`  HTTP ${v}  ${k}`)
			}
			line('\nListening 12s for pushed events…')
			setTimeout(done, 12000)
			return
		}

		if (m.envelope) events.push(m)
	})
})

rule('DONE')
process.exit(0)
