import { LuaFactory } from 'wasmoon'

export const factory = (() => {
	const factory = new LuaFactory();
	function creds (co) {
		switch (co) {
		case "anonymous":
			return "omit";
		case "use-credentials":
			return "include";
		default:
			return "same-origin";
		}
	}
	function mountbuf (buf, node, path) {
		var ui8a;
		if ("string" === typeof buf) {
			ui8a = (new TextEncoder).encode(buf);
		} else {
			ui8a = new Uint8Array(buf);
		}
		factory.mountFile(path, ui8a).then(() => {
			console.log("wasmoon-web: mounted " + path + " from " + node.src);
			node.dispatchEvent(new Event('load'));
		});
	}
	function xhrresp (xhr, node, path) {
		if (xhr.status >= 200 && xhr.status < 300) {
			mountbuf(xhr.response, node, path);
		} else {
			node.dispatchEvent(new Event("error"));
		}
	}
	function xhrreq (node, path, xasync) {
		const xhr = new XMLHttpRequest;
		xhr.open("GET", node.src, xasync);
		if (xasync) {
			xhr.responseType = "arraybuffer";
			xhr.onreadystatechange = (() => {
				if (4 === xhr.readyState) xhrresp(xhr, node, path);
			});
			xhr.send();
		} else {
			xhr.send();
			xhrresp(xhr, node, path);
		}
	}
	function fetchnode (node) {
		if (!node.src) return;
		const u = new URL(node.src);
		var path = u.pathname;
		if (u.origin == window.location.origin) {
			const rp = path.split("/").reverse();
			const wrp = window.location.pathname.split("/").reverse();
			for (; rp.length>0 && wrp.length>0 && rp[rp.length-1] == wrp[wrp.length-1];) {
				rp.pop();
				wrp.pop();
			}
			if (rp.length > 0) {
				path = rp.reverse().join("/");
			}
		}
		if ("complete" === document.readyState || node.async) {
			if ("function" == typeof fetch) {
				fetch(node.src, {
					method: "GET",
					credentials: creds(node.crossorigin),
					redirect: "follow",
					integrity: node.integrity
				}).then((resp) => {
					if (resp.ok) return resp.arrayBuffer();
					throw new Error('unable to fetch')
				}).then((buf) => {
					mountbuf(buf, node, path);
				}).catch((e) => {
					node.dispatchEvent(new Event("error"))
				});
			} else {
				xhrreq(node, path, true);
			}
		} else {
			xhrreq(node, path, false);
		}
	}
	if ("undefined" == typeof document) return;
	if (!(document instanceof HTMLDocument)) return;
	if ("undefined" == typeof MutationObserver) {
		if (console.warn) {
			console.warn("wasmoon-web: MutationObserver not found; lua script tags will not be run when inserted");
		}
		return;
	}
	factory.getLuaModule().then(() => {
		new MutationObserver((mrs, mo) => {
			const re = /^(.*?\/.*?)([\t ]*;.*)?$/;
			for (const mr of mrs) {
				for (const node of mr.addedNodes) {
					if ("SCRIPT" !== node.tagName) continue;
					var t = re.exec(node.type);
					if (!t) continue;
					var ct = t[1];
					if ("application/lua" !== ct && "text/lua" !== ct) continue;
					fetchnode(node);
				}
			}
			if ("complete" === document.readyState) {
				console.log('wasmoon-web: document loaded, no more script tags will be processed');
				mo.disconnect();
			}
		}).observe(document, {
			childList: true,
			subtree: true
		})
		Array.prototype.forEach.call(
			document.querySelectorAll('script[type^="application/lua"], script[type^="text/lua"]'),
			fetchnode
		);
	});
	return factory;
})();
