const DECODED_UNKNOWN=0;
const DECODED_FINISHED=1;
const DECODED_FORWARD=2;
const SYNC = 0xC8;
const CRSF_FRAMETYPE_RADIO_ID = 0x3A;
// CRSF durations are exchanged as 10*usec
const TIME1MSEC = 10000;
let CRC8TABLE = new Uint8Array(256);
let port = null;
let reader = null;
let read = read_cancel;
let writer = null;
let write = write_close;
let wbuf = {
	'b': new Uint8Array(256),
	'offset': 26 // first 26 bytes reserved for CRSF_FRAMETYPE_RC_CHANNELS_PACKED
}

// start with 200ms (5 Hz) updates
let write_interval = 200 * TIME1MSEC;
let write_shift = 0;
let writes_burn = 0;
let writes_st = 0;

// ch5 @ 900us, the rest @ 1500us
const crsf_rcchannels = new Uint8Array([
	0xc8,
	0x18,
	0x16,
	0xe0,
	0x03,
	0x1f,
	0xf8,
	0xc0,
	0xc7,
	0x0a,
	0xf0,
	0x81,
	0x0f,
	0x7c,
	0xe0,
	0x03,
	0x1f,
	0xf8,
	0xc0,
	0x07,
	0x3e,
	0xf0,
	0x81,
	0x0f,
	0x7c,
	0x33
]);

const address = {
	0x00: "broadcast",
	0x10: "usb",
	0x12: "bluetooth",
	0x80: "tbs_core_pnp_pro",
	0x8A: "reserved1",
	0xC0: "current_sensor",
	0xC2: "gps",
	0xC4: "tbs_blackbox",
	0xC8: "flight_controller",
	0xCA: "reserved2",
	0xCC: "race_tag",
	0xEA: "radio_transmitter",
	0xEC: "crsf_receiver",
	0xEE: "crsf_transmitter",
	0xEF: "elrs_lua"
};

function crc8init () {
	var remainder;
	for (let dividend=0; dividend<256; dividend++) {
		// 8 bit width, therefore no need to shift
		remainder = dividend;
		for (let bit=0; bit<8; bit++) {
			if ((remainder & 128) != 0) {
				remainder = (remainder << 1) ^ 0xD5;
			} else {
				remainder = remainder << 1;
			}
		}
		CRC8TABLE[dividend] = remainder & 0xFF;
	}
}

function crc8 (msg) {
	var crc = new Uint8Array(1);
	for (let i=0; i<msg.length; i++) {
		crc[0] = CRC8TABLE[(msg[i] ^ crc[0])]
	}
	crc[0] = crc[0] ^ 0x00;
	return crc;
}

function decode_extended (buf) {
	var dst = address[buf.getUint8(0)];
	var src = address[buf.getUint8(1)];
	if (dst === undefined) {
		dst = "unknown";
	}
	if (src === undefined) {
		src = "unknown";
	}
	return [ dst, src ];
}

function decode_unknown (buf, type) {
	log(`unknown ${type}: ` + hexprintable(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
	return DECODED_UNKNOWN;
}

function decode_elrs_status (buf) {
	const [ dst, src ] = decode_extended(buf);
	const nbad = buf.getUint8(2);
	const ngood = buf.getUint16(3);
	const flags = buf.getUint8(5);
	var n;
	for (n=6; n<buf.byteLength; n++) {
		if (buf.getUint8(n) == 0) break;
	}
	const msg = bytes2str(new Uint8Array(buf.buffer, buf.byteOffset+6, buf.byteLength-6));
	log(`${src}->${dst} ELRS_STATUS: nbad=${nbad} ngood=${ngood} flags=${flags} msg=${msg}`);
	return DECODED_FORWARD;
}

function decode_parameter_write (buf) {
	const [ dst, src ] = decode_extended(buf);
	const idx = buf.getUint8(2);
	log(`${src}->${dst} PARAMETER_WRITE: ${idx}`);
	return DECODED_FORWARD;
}

function decode_parameter_settings_entry (buf) {
	const [ dst, src ] = decode_extended(buf);
	var idx = buf.getUint8(2);
	var left = buf.getUint8(3);
	var end = new Uint8Array(buf.buffer, buf.byteOffset+4, buf.byteLength-4);
	log(`${src}->${dst} SETTINGS_ENTRY: ${idx} ${left}: ${hexprintable(end)}`);
	return DECODED_FORWARD;
}

function decode_device_info (buf) {
	const [ dst, src ] = decode_extended(buf);
	const stringmax = buf.byteLength - 12;
	var name, serial, hwver, maj, min, rev, npar, pver;
	var n;
	for (n=2; n<stringmax; n++) {
		if (buf.getUint8(n) == 0) break;
	}
	if (n < stringmax) {
		name = bytes2str(new Uint8Array(buf.buffer, buf.byteOffset+2, n-2), 32);
		n++;
		serial = bytes2str(new Uint8Array(buf.buffer, buf.byteOffset+n, 4));
		n += 4;
		hwver = buf.getUint32(n);
		n += 4;
		n++; // ignore first byte of swver
		maj = buf.getUint8(n++);
		min = buf.getUint8(n++);
		rev = buf.getUint8(n++);
		npar = buf.getUint8(n++);
		pver = buf.getUint8(n++);
		log(`${src}->${dst} DEVICE_INFO: ${name} (${serial}) hwver=${hwver} swver=${maj}.${min}.${rev} npar=${npar} pver=${pver}`);
	}
	return DECODED_FORWARD;
}

function decode_radio_id (buf) {
	var interval, shift;
	if (buf.getUint8(2) == 16) {
		interval = buf.getInt32(3);
		shift = buf.getInt32(7);
		self.postMessage(["sync", (10000000/interval).toFixed(1), shift]);
		if (interval != write_interval) {
			log(`worker adjusting loopinterval ${write_interval}=>${interval}`);
			write_interval = interval;
		}
		write_shift = shift;
		// for debugging timing issues
		//console.log(`sync ${shift}`);
	} else {
		log('SYNC: unknown subtype!');
	}
	return DECODED_FINISHED;
}

function decode_radio_id_start (buf) {
	self.postMessage(['start']);
	DECODE[CRSF_FRAMETYPE_RADIO_ID] = decode_radio_id;
	return decode_radio_id(buf);
}

// I love me a jump table
const DECODE = Array(
	decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_GPS
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_VARIO
	decode_unknown, // CRSF_FRAMETYPE_BATTERY_SENSOR
	decode_unknown, // CRSF_FRAMETYPE_BARO_ALTITUDE
	decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_HEARTBEAT
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_LINK_STATISTICS
	decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_RC_CHANNELS_PACKED
	decode_unknown, // CRSF_FRAMETYPE_SUBSET_RC_CHANNELS_PACKED
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_LINK_RX_ID
	decode_unknown, // CRSF_FRAMETYPE_LINK_TX_ID
	decode_unknown, // CRSF_FRAMETYPE_ATTITUDE
	decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_FLIGHT_MODE
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_DEVICE_PING
	decode_device_info,
	decode_unknown,
	decode_parameter_settings_entry, // CRSF_FRAMETYPE_PARAMETER_SETTINGS_ENTRY
	decode_unknown, // CRSF_FRAMETYPE_PARAMETER_READ
	decode_parameter_write, // CRSF_FRAMETYPE_PARAMETER_WRITE
	decode_elrs_status, // CRSF_FRAMETYPE_ELRS_STATUS
	decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_COMMAND
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown,
	decode_radio_id_start, // CRSF_FRAMETYPE_RADIO_ID
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_KISS_REQ
	decode_unknown, // CRSF_FRAMETYPE_KISS_RESP
	decode_unknown, // CRSF_FRAMETYPE_MSP_REQ
	decode_unknown, // CRSF_FRAMETYPE_MSP_RESP
	decode_unknown, // CRSF_FRAMETYPE_MSP_WRITE
	decode_unknown, // CRSF_FRAMETYPE_DISPLAYPORT_CMD
	decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_ARDUPILOT_RESP
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown
);
	
function log (msg) {
	self.postMessage(["log", msg]);
}

function hex (buf) {
	let out = [];
	for (let i=0; i<buf.length; i++) {
		out.push(("0" + buf[i].toString(16).toUpperCase()).substr(-2));
	}
	return out.join(" ");
}

function bytes2str (buf, lowest=33) {
	// set lowest=32 to include space characters
	var out = '';
	for (let i=0; i<buf.length; i++) {
		if (buf[i] < lowest || buf[i] > 126) {
			out += ".";
		} else {
			out += String.fromCharCode(buf[i]);
		}
	}
	return out;
}

function hexprintable (buf) {
	let out = hex(buf) + ' [' + bytes2str(buf) + ']';
	return out;
}

function validate_packet (buf) {
	return (crc8(buf.subarray(2,-1)).at(0) == buf.at(-1));
}

function buf_shift (buf, shift, offset) {
	let tbuf = new Uint8Array(buf, 0, offset);
	if (shift < offset) {
		// copy over noise
		tbuf.copyWithin(0, shift, offset);
	}
	return offset-shift;
}

function port_close (timeout=false) {
	if (!timeout) {
		// for some fkd up reason, port.close() fails bizarrely without this
		setTimeout(port_close, 10, true);
		return;
	}
	port.close().then(() => {
		self.postMessage(["stopped"]);
	});
}

function read_stop () {
	reader = null;
	if (writer == null) {
		port_close();
	}
}

function read_cancel () {
	if (reader == null) return;
	reader.cancel().then(() => {
		reader.releaseLock();
		read_stop();
	});
}

function read_run (rbuf = new ArrayBuffer(255), offset = 0) {
	return reader.read(
		new Uint8Array(rbuf, offset, rbuf.byteLength-offset)
	).then(({value, done}) => {
		if (done) {
			return;
		}
		offset += value.length;
		while (offset > 3) {
			// check for any valid packets in potential noise
			let tblen = offset;
			let tboffset = 0;
			let len = 0;
			do {
				const tbuf = new Uint8Array(value.buffer, tboffset, tblen);
				len = tbuf[1] + 2; // length including sync and len bytes
				if (len > 64 || len < 4) {
					tboffset += 2;
					tblen -= 2;
					len = 0
					continue;
				}
				if (len > tblen) {
					len = 0;
					break;
				}
				if (!validate_packet(tbuf.subarray(0, len))) {
					tboffset += 2;
					tblen -= 2;
					len = 0;
					continue;
				}
				// found a valid packet
				break;
			} while (tblen > 1);
			if (tboffset > 0) {
				log("noise: " + hexprintable(new Uint8Array(value.buffer, 0, tboffset)));
				offset = buf_shift(value.buffer, tboffset, offset);
			}
			if (len == 0) {
				// no packet leftover
				break;
			}
			let packet = new Uint8Array(value.buffer, 0, len);
			let type = packet[2];
			let payload = new DataView(value.buffer, 3, len-4);
			if (DECODE[type](payload, type) == DECODED_FORWARD) {
				self.postMessage(["crsfrecv", type, [...packet.subarray(3, -1)]]);
			}
			offset = buf_shift(value.buffer, len, offset);
		}
		return read(value.buffer, offset);
	});/*.catch((e) => {
		console.log(`worker error: read ${e.name} ${e.message}`);
		read = read_cancel;
		read_stop();
	});*/
}

function write_stop () {
	writer = null;
	if (reader == null) {
		port_close();
	}
}

function write_close () {
	if (writer == null) return;
	writer.ready.then(() => {
		writer.close();
	}).then(() => {
		writer.releaseLock();
		write_stop();
	});
}

function write_burn (lastwrite) {
	let burndelay = ((write_interval + write_shift) / TIME1MSEC) - (performance.now() - lastwrite) + 0.5;
	// for debugging timing issues
	// console.log(`write_burn ${lastwrite} ${write_shift} ${burndelay}`);
	while ((performance.now() - lastwrite) < burndelay);
	write();
}

function write_run () {
	if (writes_burn+writes_st > 300) {
		log(`writes_burn=${writes_burn} writes_st=${writes_st}`);
		writes_burn = writes_st = 0;
	}
	writer.write(wbuf.b.subarray(0, wbuf.offset)).then(() => {
		let lastwrite = performance.now();
		const writedelay = (write_interval + write_shift) / TIME1MSEC;
		// for debugging timing issues
		// const t_write_shift = write_shift;
		wbuf.offset = 26;
		write_shift = 0;
		if (writedelay >= 3.7) {
			// for debugging timing issues
			// console.log(`write_st ${lastwrite} ${t_write_shift} ${writedelay}`);
			writes_st++;
			setTimeout(write, Math.floor(writedelay), lastwrite);
			return;
		}
		// Browsers impose a minimum delay of 4 ms to setTimeout() calls
		// so the best workaround seems to be sending a message and
		// then burning up some cycles for the rest of the timeout
		writes_burn++;
		self.postMessage(["writeburn", lastwrite]);
	}).catch((e) => {
		console.log(`worker error: write ${e.name} ${e.message}`);
		write = write_close;
		write_stop();
	});
}

uimessage = {
	'start': function (data) {
		wbuf.b.set(crsf_rcchannels);
		DECODE[CRSF_FRAMETYPE_RADIO_ID] = decode_radio_id_start;
		navigator.serial.getPorts().then((ports) => {
			if (ports.length < 1) {
				log('error connecting: no ports found');
				return;
			}
			port = ports[0];
			port.open({baudRate: 4000000}).then(() => {
				log('connected to port');
				writer = port.writable.getWriter();
				write = write_run;
				write();
				reader = port.readable.getReader({mode:'byob'});
				read = read_run;
				read();
				self.postMessage(["started"]);
				self.postMessage(["sync", (10000000/write_interval).toFixed(1), 0]);
			}).catch((e) => {
				log(`error connecting to port: ${e.name} ${e.message}`);
			});
		}).catch((e) => {
			log(`worker error: onmessage ${e.name} ${e.message}`);
		});
	},
	'stop': function (data) {
		try {
			write = write_close;
			read = read_cancel;
			read();
		} catch (e) {
			console.log(`worker error: onmessage ${e.name} ${e.message}`);
		}
	},
	'writeburn': function (data) {
		write_burn(data[1]);
	},
	'crsfsend': function (data) {
		const len = data[2].length + 2;
		const start = wbuf.offset;
		const cst = wbuf.offset + 2;
		wbuf.b.set([SYNC, len, data[1]], wbuf.offset);
		wbuf.offset += 3;
		wbuf.b.set(data[2], wbuf.offset);
		wbuf.offset += data[2].length;
		wbuf.b.set(crc8(wbuf.b.subarray(cst, wbuf.offset)), wbuf.offset++);
		log(`worker sending: ${hexprintable(wbuf.b.subarray(start,wbuf.offset))}`);
	},
	'crctable': function (data) {
		console.log(`${CRC8TABLE}`);
	},
	'crc8': function (data) {
		console.log(`${crc8(ev.data[1])}`);
	}
}
onmessage = function (ev) { return uimessage[ev.data[0]](ev.data); }
crc8init();
