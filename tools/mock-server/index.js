#!/usr/bin/env node
/**
 * Mock Shure SystemAPI Server for developing the Companion module on macOS/Linux.
 *
 * Starts two listeners:
 *   - HTTPS on --port (default 10000): the Shure-compatible API the module talks to
 *   - HTTP  on --ui-port (default 10001): the simulator control panel
 *
 * Usage: node tools/mock-server/index.js [--port 10000] [--ui-port 10001]
 *                                        [--key <api key>] [--list-shape paginated|array|items]
 */

import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { SimState, BATTERY_STATES, ACTIVITY_LEVELS } from './state.js'
import { attachApi } from './api.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Minimal argv parser for --flag value pairs.
 * @returns {Object} parsed options
 */
function parseArgs() {
	const out = {}
	const argv = process.argv.slice(2)
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) {
			const key = argv[i].slice(2)
			const next = argv[i + 1]
			if (next && !next.startsWith('--')) {
				out[key] = next
				i++
			} else {
				out[key] = true
			}
		}
	}
	return out
}

const args = parseArgs()
const PORT = Number(args.port ?? 10000)
const UI_PORT = Number(args['ui-port'] ?? 10001)
const API_KEY = String(args.key ?? 'mock-shure-api-key')
const LIST_SHAPE = String(args['list-shape'] ?? 'paginated')

/**
 * Generate (once) and load a self-signed certificate, mirroring the real
 * server's default localhost self-signed cert.
 *
 * @returns {Object} { key, cert }
 */
function loadCert() {
	const dir = path.join(here, '.cert')
	const keyPath = path.join(dir, 'key.pem')
	const certPath = path.join(dir, 'cert.pem')

	if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
		fs.mkdirSync(dir, { recursive: true })
		execFileSync('openssl', [
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			keyPath,
			'-out',
			certPath,
			'-days',
			'3650',
			'-subj',
			'/CN=localhost',
			'-addext',
			'subjectAltName=DNS:localhost,IP:127.0.0.1',
		])
		console.log(`Generated self-signed certificate in ${dir}`)
	}

	return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
}

// ---------------------------------------------------------------- simulation

const state = new SimState()

// A starting rig that covers the interesting variety: an ADPSM transmitter
// (no mute), an ANX4 receiver (channels DO have mute) and two battery packs.
const adtq = state.addDevice('ADTQ', { name: 'ADTQ A' })
state.addDevice('ANX4', { name: 'ANX4 Rack' })
state.addDevice('ULXD6', { name: 'Lead Vox Pack', parentId: adtq.deviceId, parentChannel: 1 })
state.addDevice('ULXD8', { name: 'Handheld 1', parentId: adtq.deviceId, parentChannel: 2 })
state.start()

// ---------------------------------------------------------------- API server

const apiServer = https.createServer(loadCert())
const api = attachApi(apiServer, state, { apiKey: API_KEY, listShape: LIST_SHAPE })

apiServer.on('request', (req, res) => {
	if (api.handleRequest(req, res)) return
	res.writeHead(404, { 'Content-Type': 'application/json' })
	res.end(JSON.stringify({ message: 'Not found' }))
})

apiServer.listen(PORT, () => {
	console.log(`\n  Shure SystemAPI (mock)   https://127.0.0.1:${PORT}/api/v1`)
	console.log(`  API key                  ${API_KEY}`)
	console.log(`  Device list shape        ${LIST_SHAPE}`)
})

// ----------------------------------------------------------------- UI server

/**
 * Simulator control API + static UI. Kept separate from the Shure-compatible
 * surface so the browser does not have to accept the self-signed cert.
 */
const uiServer = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://localhost')

	if (url.pathname === '/' || url.pathname === '/index.html') {
		const html = fs.readFileSync(path.join(here, 'public', 'index.html'))
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
		res.end(html)
		return
	}

	if (url.pathname === '/sim/state' && req.method === 'GET') {
		res.writeHead(200, { 'Content-Type': 'application/json' })
		res.end(
			JSON.stringify({
				apiUrl: `https://127.0.0.1:${PORT}`,
				apiKey: API_KEY,
				listShape: LIST_SHAPE,
				batteryStates: BATTERY_STATES,
				activityLevels: ACTIVITY_LEVELS,
				transports: api.transports.size,
				devices: state.list().map((d) => ({
					deviceId: d.deviceId,
					model: d.model,
					name: d.name,
					deviceState: d.deviceState,
					address: d.address,
					firmwareVersion: d.firmwareVersion,
					identifying: d.identifying,
					audioMute: d.audioMute,
					parentId: d.parentId,
					parentChannel: d.parentChannel,
					hasAudioMute: d.capabilities.includes('audio-mute'),
					battery: d.battery,
					channels: d.channels.map((c) => ({
						id: c.id,
						index: c.index,
						name: c.name,
						muted: c.muted,
						gain: c.gain,
						gainRange: c.gainRange,
						activity: c.activity,
					})),
				})),
			}),
		)
		return
	}

	if (url.pathname === '/sim/action' && req.method === 'POST') {
		let raw = ''
		req.on('data', (c) => (raw += c))
		req.on('end', () => {
			let msg
			try {
				msg = JSON.parse(raw)
			} catch (_err) {
				res.writeHead(400).end()
				return
			}

			try {
				switch (msg.action) {
					case 'addDevice':
						state.addDevice(msg.model, { name: msg.name, parentId: msg.parentId, parentChannel: msg.parentChannel })
						break
					case 'removeDevice':
						state.removeDevice(msg.deviceId)
						break
					case 'setDevice':
						state.setDeviceField(msg.deviceId, msg.field, msg.value)
						break
					case 'setBattery':
						state.setBatteryField(msg.deviceId, msg.field, msg.value)
						break
					case 'setChannel':
						state.setChannelField(msg.deviceId, msg.channelId, msg.field, msg.value)
						break
					default:
						res.writeHead(400).end()
						return
				}
				res.writeHead(204).end()
			} catch (err) {
				res.writeHead(500, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ message: err.message }))
			}
		})
		return
	}

	res.writeHead(404).end()
})

uiServer.listen(UI_PORT, () => {
	console.log(`  Simulator control panel  http://127.0.0.1:${UI_PORT}\n`)
})

process.on('SIGINT', () => {
	state.stop()
	apiServer.close()
	uiServer.close()
	process.exit(0)
})
