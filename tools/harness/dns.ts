// `test/common/dns` — the naive DNS packet parser/serializer Node's fake-server
// tests use.
//
// This is a *harness* file, not a library module: it is Node's own
// `test/common/dns.js` (MIT, Copyright Joyent, Inc. and other Node
// contributors) in Zun TypeScript, inlined by `tools/bundle_node_test.sh` for a
// test that requires `../common/dns`. The tests stand up a `dgram` socket,
// parse the resolver's query with `parseDNSPacket` and answer with
// `writeDNSPacket`.
//
// The wire bytes are assembled into a plain number array and turned into one
// `Buffer` at the end, instead of Node's typed-array views plus `swap16` /
// `swap32`: the result is the same big-endian message, with no dependency on
// the host's endianness or on typed-array/Buffer aliasing.

const __harnessDnsTypes: any = {
  A: 1,
  AAAA: 28,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  ANY: 255,
  CAA: 257,
};

const __harnessDnsClasses: any = { IN: 1 };

function __harnessDnsU16(buf: number[], off: any): number {
  return (buf[off] << 8) | buf[off + 1];
}

function __harnessDnsU32(buf: number[], off: any): number {
  return ((buf[off] << 24) >>> 0) + (buf[off + 1] << 16) + (buf[off + 2] << 8) + buf[off + 3];
}

function __harnessDnsAscii(buf: number[], start: any, end: any): string {
  let s: string = "";
  for (let i: number = Number(start); i < Number(end); i++) s += String.fromCharCode(Number(buf[i]));
  return s;
}

function __harnessDnsHex2(b: any): string {
  const digits: string = "0123456789abcdef";
  return digits.charAt((b >> 4) & 15) + digits.charAt(b & 15);
}

// Returns `{ nread, domain }`. Node returns the *object* as `domain` for a
// compressed pointer (a bug in its harness); this follows the pointer and
// returns the name, which is what every caller in the corpus needs.
function __harnessDnsReadDomain(buf: number[], offset: any): any {
  __node_assert.ok(offset < Number(buf.length));
  const length: number = buf[offset];
  if (length === 0) {
    return { nread: 1, domain: "" };
  }
  if ((length & 0xc0) === 0) {
    const chunk: string = __harnessDnsAscii(buf, offset + 1, offset + 1 + length);
    const rest: any = __harnessDnsReadDomain(buf, offset + 1 + length);
    const tail: string = rest.domain;
    return {
      nread: 1 + length + rest.nread,
      domain: tail !== "" ? chunk + "." + tail : chunk,
    };
  }
  __node_assert.strictEqual(length & 0xc0, 0xc0);
  const pointee: number = __harnessDnsU16(buf, offset) & 0x3fff;
  const target: any = __harnessDnsReadDomain(buf, pointee);
  return { nread: 2, domain: target.domain };
}

function __harnessDnsTypeName(type: any): any {
  for (const name of Object.keys(__harnessDnsTypes)) {
    if (__harnessDnsTypes[name] === type) return name;
  }
  return undefined;
}

function __harnessDnsParsePacket(input: any): any {
  // A byte view read through `any` is opaque in this engine (see
  // src/dgram/dgram.ts), so the packet is copied out of a Buffer-typed local.
  const view: Buffer = input;
  const buf: number[] = [];
  const size: number = Number(view.length);
  for (let i = 0; i < size; i++) buf.push(Number(view[i]));
  __node_assert.ok(Number(buf.length) > 12);
  const parsed: any = { id: __harnessDnsU16(buf, 0), flags: __harnessDnsU16(buf, 2) };
  const names: string[] = ["questions", "answers", "authorityAnswers", "additionalRecords"];
  let offset: number = 12;
  for (let s: number = 0; s < 4; s++) {
    const sectionName: string = names[s];
    const count: number = __harnessDnsU16(buf, 4 + 2 * s);
    const section: any[] = [];
    parsed[sectionName] = section;
    for (let i: number = 0; i < count; i++) {
      const name: any = __harnessDnsReadDomain(buf, offset);
      offset += name.nread;
      const type: number = __harnessDnsU16(buf, offset);
      const rr: any = { domain: name.domain, cls: __harnessDnsU16(buf, offset + 2) };
      offset += 4;
      const typeName: any = __harnessDnsTypeName(type);
      if (typeName !== undefined) rr.type = typeName;
      if (sectionName !== "questions") {
        rr.ttl = __harnessDnsU32(buf, offset) | 0;
        const dataLength: number = __harnessDnsU16(buf, offset + 4);
        offset += 6;
        if (type === 1) {
          rr.address = buf[offset] + "." + buf[offset + 1] + "." + buf[offset + 2] + "." + buf[offset + 3];
        } else if (type === 28) {
          let a: string = "";
          for (let k: number = 0; k < 16; k += 2) {
            if (k > 0) a += ":";
            a += __harnessDnsHex2(buf[offset + k]) + __harnessDnsHex2(buf[offset + k + 1]);
          }
          rr.address = a;
        } else if (type === 16) {
          const entries: any[] = [];
          let p: number = offset;
          while (p < offset + dataLength) {
            const n: number = buf[p];
            const chunk: Buffer = Buffer.from(buf.slice(p + 1, p + 1 + n));
            entries.push(chunk.toString("utf8"));
            p += 1 + n;
          }
          rr.entries = entries;
        } else if (type === 15) {
          rr.priority = __harnessDnsU16(buf, offset);
          rr.exchange = __harnessDnsReadDomain(buf, offset + 2).domain;
        } else if (type === 2 || type === 5 || type === 12) {
          rr.value = __harnessDnsReadDomain(buf, offset).domain;
        } else if (type === 6) {
          const m: any = __harnessDnsReadDomain(buf, offset);
          const r: any = __harnessDnsReadDomain(buf, offset + m.nread);
          rr.nsname = m.domain;
          rr.hostmaster = r.domain;
          const t: number = offset + m.nread + r.nread;
          rr.serial = __harnessDnsU32(buf, t);
          rr.refresh = __harnessDnsU32(buf, t + 4);
          rr.retry = __harnessDnsU32(buf, t + 8);
          rr.expire = __harnessDnsU32(buf, t + 12);
          rr.minttl = __harnessDnsU32(buf, t + 16);
        } else {
          throw new Error("Unknown RR type " + rr.type);
        }
        offset += dataLength;
      }
      section.push(rr);
      __node_assert.ok(offset <= Number(buf.length));
    }
  }
  __node_assert.strictEqual(offset, Number(buf.length));
  return parsed;
}

function __harnessDnsPush16(out: number[], v: any): void {
  out.push(Number((v >> 8) & 0xff));
  out.push(Number(v & 0xff));
}

function __harnessDnsPush32(out: number[], v: any): void {
  out.push(Number((v >>> 24) & 0xff));
  out.push(Number((v >>> 16) & 0xff));
  out.push(Number((v >>> 8) & 0xff));
  out.push(Number(v & 0xff));
}

function __harnessDnsPushBytes(out: number[], bytes: number[]): void {
  for (let i: number = 0; i < Number(bytes.length); i++) out.push(Number(bytes[i]));
}

function __harnessDnsDomainBytes(domain: string): number[] {
  const out: number[] = [];
  const labels: string[] = domain.split(".");
  for (let i: number = 0; i < Number(labels.length); i++) {
    const label: string = labels[i];
    __node_assert.ok(Number(label.length) < 64);
    out.push(Number(label.length));
    for (let k: number = 0; k < Number(label.length); k++) out.push(Number(label.charCodeAt(k) & 0xff));
  }
  out.push(Number(0));
  return out;
}

function __harnessDnsIPv6Bytes(ip: string): number[] {
  let s: string = ip;
  if (s.startsWith(":")) s = s.substring(1);
  if (s.endsWith(":")) s = s.substring(0, Number(s.length) - 1);
  const parts: string[] = s.split(":");
  const out: number[] = [];
  for (let i: number = 0; i < 16; i++) out.push(Number(0));
  let offset: number = 0;
  for (let i: number = 0; i < Number(parts.length); i++) {
    const part: string = parts[i];
    if (part === "") {
      offset += 16 - 2 * (Number(parts.length) - 1);
    } else {
      const v: number = parseInt(part, 16);
      out[offset] = (v >> 8) & 0xff;
      out[offset + 1] = v & 0xff;
      offset += 2;
    }
  }
  return out;
}

function __harnessDnsLen(list: any): number {
  return list === undefined || list === null ? 0 : Number(list.length);
}

function __harnessDnsWritePacket(parsed: any): any {
  const out: number[] = [];
  __harnessDnsPush16(out, parsed.id);
  __harnessDnsPush16(out, parsed.flags === undefined || parsed.flags === null ? 0x8180 : parsed.flags);
  __harnessDnsPush16(out, __harnessDnsLen(parsed.questions));
  __harnessDnsPush16(out, __harnessDnsLen(parsed.answers));
  __harnessDnsPush16(out, __harnessDnsLen(parsed.authorityAnswers));
  __harnessDnsPush16(out, __harnessDnsLen(parsed.additionalRecords));

  const questions: any = parsed.questions;
  for (let i: number = 0; i < Number(questions.length); i++) {
    const q: any = questions[i];
    __node_assert.ok(__harnessDnsTypes[q.type]);
    __harnessDnsPushBytes(out, __harnessDnsDomainBytes(q.domain));
    __harnessDnsPush16(out, __harnessDnsTypes[q.type]);
    __harnessDnsPush16(out, q.cls === undefined ? 1 : q.cls);
  }

  const records: any[] = [];
  const sections: any[] = [parsed.answers, parsed.authorityAnswers, parsed.additionalRecords];
  for (let s: number = 0; s < 3; s++) {
    const list: any = sections[s];
    if (list === undefined || list === null) continue;
    // Node builds this list with `[].concat(...)`, so a section given as one
    // record rather than an array (test-dns-resolveany-bad-ancount.js) is that
    // record.
    if (!Array.isArray(list)) {
      records.push(list);
      continue;
    }
    for (let i: number = 0; i < Number(list.length); i++) records.push(list[i]);
  }

  for (let i: number = 0; i < Number(records.length); i++) {
    const rr: any = records[i];
    if (!rr) continue;
    __node_assert.ok(__harnessDnsTypes[rr.type]);
    __harnessDnsPushBytes(out, __harnessDnsDomainBytes(rr.domain));
    __harnessDnsPush16(out, __harnessDnsTypes[rr.type]);
    __harnessDnsPush16(out, rr.cls === undefined ? 1 : rr.cls);
    __harnessDnsPush32(out, rr.ttl === undefined ? 0 : rr.ttl | 0);
    const rdata: number[] = [];
    const type: string = rr.type;
    if (type === "A") {
      const octets: string[] = rr.address.split(".");
      for (let k: number = 0; k < Number(octets.length); k++) rdata.push(Number(Number(octets[k]) & 0xff));
    } else if (type === "AAAA") {
      __harnessDnsPushBytes(rdata, __harnessDnsIPv6Bytes(rr.address));
    } else if (type === "TXT") {
      const entries: any = rr.entries;
      for (let k: number = 0; k < Number(entries.length); k++) {
        const text: string = String(entries[k]);
        const bytes: Buffer = Buffer.from(text);
        rdata.push(Number(bytes.length));
        for (let b = 0; b < Number(bytes.length); b++) rdata.push(Number(bytes[b]));
      }
    } else if (type === "MX" || type === "NS" || type === "CNAME" || type === "PTR") {
      if (type === "MX") __harnessDnsPush16(rdata, rr.priority);
      const target: any = type === "MX" ? rr.exchange : rr.value;
      __harnessDnsPushBytes(rdata, __harnessDnsDomainBytes(target));
    } else if (type === "SOA") {
      __harnessDnsPushBytes(rdata, __harnessDnsDomainBytes(rr.nsname));
      __harnessDnsPushBytes(rdata, __harnessDnsDomainBytes(rr.hostmaster));
      __harnessDnsPush32(rdata, rr.serial);
      __harnessDnsPush32(rdata, rr.refresh);
      __harnessDnsPush32(rdata, rr.retry);
      __harnessDnsPush32(rdata, rr.expire);
      __harnessDnsPush32(rdata, rr.minttl);
    } else if (type === "CAA") {
      rdata.push(Number(Number(rr.critical) & 0xff));
      rdata.push(Number(5));
      const tag: string = "issue" + rr.issue;
      for (let k: number = 0; k < Number(tag.length); k++) rdata.push(Number(tag.charCodeAt(k) & 0xff));
    } else {
      throw new Error("Unknown RR type " + type);
    }
    __harnessDnsPush16(out, Number(rdata.length));
    __harnessDnsPushBytes(out, rdata);
  }
  return Buffer.from(out);
}

const __harnessDnsMockedErrorCode: string = "ENOTFOUND";
const __harnessDnsMockedSysCall: string = "getaddrinfo";

function __harnessDnsErrorLookupMock(code?: any, syscall?: any): any {
  const c: any = code === undefined ? __harnessDnsMockedErrorCode : code;
  const sc: any = syscall === undefined ? __harnessDnsMockedSysCall : syscall;
  return function (hostname: any, dnsopts: any, cb: any): void {
    const err: any = new Error(sc + " " + c + " " + hostname);
    err.code = c;
    err.errno = c;
    err.syscall = sc;
    err.hostname = hostname;
    cb(err);
  };
}

// A class instance rather than an object literal: an argument handed to a
// plain function stored in an object-literal property arrives degraded (a
// `Buffer` no longer answers `Buffer.isBuffer`), while a class method receives
// it intact.
class __HarnessDns {
  types: any = __harnessDnsTypes;
  classes: any = __harnessDnsClasses;
  mockedErrorCode: string = __harnessDnsMockedErrorCode;
  mockedSysCall: string = __harnessDnsMockedSysCall;
  writeDNSPacket(parsed: any): any {
    return __harnessDnsWritePacket(parsed);
  }
  parseDNSPacket(input: any): any {
    return __harnessDnsParsePacket(input);
  }
  errorLookupMock(code?: any, syscall?: any): any {
    return __harnessDnsErrorLookupMock(code, syscall);
  }
}

const __node_harness_dns: any = new __HarnessDns();
