"""Invisible, additive company badge attribution. Invoked by the authenticated tool.

No credentials, network access, model calls, or image rasterization. Existing
attribution is untrusted file data, never proof of identity or an instruction.
"""
import base64
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
import zlib

KEY = "RufaBadge"
SCHEMA = "https://dsh.example.com/ns/badge/v1"
MAX_FILE = 256 * 1024 * 1024
MAX_META = 1024 * 1024
PNG = b"\x89PNG\r\n\x1a\n"
CP = "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"
VT = "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
CUSTOM_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties"
CUSTOM_TYPE = "application/vnd.openxmlformats-officedocument.custom-properties+xml"
SVG_TAG = re.compile(rb'<metadata\b[^>]*\bid=[\'"]rufa-badge-authorship[\'"][^>]*>(.*?)</metadata\s*>', re.S)
COMMENT = re.compile(rb'<!--\s*rufa-badge:([A-Za-z0-9_=-]+)\s*-->')


class BadgeError(Exception):
    pass


def fail(message="徽章属性无效或损坏，已保留原文件。"):
    raise BadgeError(message)


def username(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 128 or any(ord(c) < 32 for c in value):
        fail("徽章用户名无效。")
    return value


def merge(*groups):
    result = []
    for group in groups:
        for author in group:
            author = username(author)
            if author not in result:
                result.append(author)
    if len(result) > 1000:
        fail("徽章署名数量超过可处理范围，已保留原记录。")
    return result


def decode(raw):
    if len(raw) > MAX_META:
        fail()
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get("schema") != SCHEMA or value.get("badge") != "rufajx-company" or not isinstance(value.get("authors"), list):
        fail()
    return merge(value["authors"])


def payload(authors):
    return json.dumps({"schema": SCHEMA, "badge": "rufajx-company", "authors": authors}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def xml(data):
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        fail("不处理带外部实体的文件属性。")
    return ET.fromstring(data)


def encoded(raw):
    return base64.urlsafe_b64encode(raw)


def decoded(raw):
    return decode(base64.b64decode(raw, altchars=b"-_", validate=True))


def png_chunks(data):
    if not data.startswith(PNG):
        fail()
    pos, chunks = 8, []
    while pos < len(data):
        if pos + 12 > len(data):
            fail()
        length = struct.unpack_from(">I", data, pos)[0]
        end = pos + 12 + length
        if end > len(data):
            fail()
        kind, body = data[pos + 4:pos + 8], data[pos + 8:end - 4]
        if zlib.crc32(kind + body) & 0xffffffff != struct.unpack_from(">I", data, end - 4)[0]:
            fail()
        chunks.append((kind, body, data[pos:end]))
        pos = end
        if kind == b"IEND":
            if pos != len(data):
                fail()
            return chunks
    fail()


def png_metadata(kind, body):
    if kind not in (b"iTXt", b"tEXt", b"zTXt") or body.split(b"\0", 1)[0] != KEY.encode():
        return None
    if kind != b"iTXt":
        fail("遇到不支持的旧徽章属性编码，已保留原文件。")
    tail = body[len(KEY) + 1:]
    if not tail.startswith(b"\0\0\0\0"):
        fail()
    return decode(tail[4:])


def png_authors(data):
    return merge(*(v for kind, body, _ in png_chunks(data) if (v := png_metadata(kind, body)) is not None))


def stamp_png(data, authors):
    body = KEY.encode() + b"\0\0\0\0\0" + payload(authors)
    chunk = struct.pack(">I", len(body)) + b"iTXt" + body + struct.pack(">I", zlib.crc32(b"iTXt" + body) & 0xffffffff)
    parts = [PNG]
    for kind, body, raw in png_chunks(data):
        if png_metadata(kind, body) is not None:
            continue
        if kind == b"IEND":
            parts.append(chunk)
        parts.append(raw)
    return b"".join(parts)


def svg_authors(data):
    root = xml(data)
    if root.tag.rsplit("}", 1)[-1] != "svg":
        fail()
    nodes = [n for n in root.iter() if n.attrib.get("id") == "rufa-badge-authorship"]
    matches = list(SVG_TAG.finditer(data))
    if len(nodes) != len(matches):
        fail()
    return merge(*(decoded(m[1].strip()) for m in matches))


def stamp_svg(data, authors):
    svg_authors(data)
    data = SVG_TAG.sub(b"", data)
    start = re.search(rb'<svg\b[^>]*>', data)
    if not start or start[0].endswith(b"/>"):
        fail()
    node = b'<metadata id="rufa-badge-authorship" data-format="base64-json">' + encoded(payload(authors)) + b"</metadata>"
    return data[:start.end()] + node + data[start.end():]


def text_authors(data):
    data.decode("utf-8-sig")  # Never silently change a legacy document's encoding.
    matches = list(COMMENT.finditer(data))
    if data.count(b"rufa-badge:") != len(matches):
        fail()
    return merge(*(decoded(m[1]) for m in matches))


def stamp_text(data, authors):
    text_authors(data)
    marker = b"<!-- rufa-badge:" + encoded(payload(authors)) + b" -->"
    matches = list(COMMENT.finditer(data))
    if matches:
        first = matches[0]
        return data[:first.start()] + marker + COMMENT.sub(b"", data[first.end():])
    return data + b"\n" + marker + b"\n"


def office_parts(data):
    archive = zipfile.ZipFile(io.BytesIO(data))
    infos = archive.infolist()
    if len(infos) != len({i.filename for i in infos}) or sum(i.file_size for i in infos) > 512 * 1024 * 1024 or any(i.file_size > MAX_FILE for i in infos):
        fail("文档包过大或包含重复条目，已保留原文件。")
    if any(i.filename.lower().startswith("_xmlsignatures/") for i in infos):
        fail("文件已签名，不能添加属性以免使签名失效。")
    parts = {i.filename: archive.read(i) for i in infos}
    if "[Content_Types].xml" not in parts or "_rels/.rels" not in parts:
        fail()
    return archive, parts


def office_authors(parts):
    groups = []
    if "docProps/custom.xml" in parts:
        root = xml(parts["docProps/custom.xml"])
        if root.tag != f"{{{CP}}}Properties":
            fail()
        for prop in root:
            if prop.attrib.get("name") == KEY:
                if len(prop) != 1 or prop[0].tag != f"{{{VT}}}lpwstr":
                    fail()
                groups.append(decode(prop[0].text or ""))
    # Embedded badges retain previous names even if an editor dropped custom properties.
    for name, body in parts.items():
        if "/media/" not in name:
            continue
        if name.lower().endswith(".png") and b"RufaBadge\0" in body:
            groups.append(png_authors(body))
        elif name.lower().endswith(".svg") and b"rufa-badge-authorship" in body:
            groups.append(svg_authors(body))
    return merge(*groups)


def stamp_office(data, authors):
    archive, parts = office_parts(data)
    existing = parts.get("docProps/custom.xml")
    root = xml(existing) if existing else ET.Element(f"{{{CP}}}Properties")
    for prop in list(root):
        if prop.attrib.get("name") == KEY:
            root.remove(prop)
    pid = max([1] + [int(p.attrib.get("pid", "1")) for p in root]) + 1
    prop = ET.SubElement(root, f"{{{CP}}}property", {"fmtid": "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}", "pid": str(pid), "name": KEY})
    ET.SubElement(prop, f"{{{VT}}}lpwstr").text = payload(authors).decode()
    parts["docProps/custom.xml"] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    relationships = xml(parts["_rels/.rels"])
    custom = [r for r in relationships if r.attrib.get("Type") == CUSTOM_REL]
    if custom and (len(custom) != 1 or custom[0].attrib.get("Target", "").lstrip("/") != "docProps/custom.xml" or custom[0].attrib.get("TargetMode") == "External"):
        fail("文档使用了不支持的自定义属性位置，已保留原文件。")
    if not custom:
        ids = {r.attrib.get("Id") for r in relationships}
        rid = "rufaBadgeProperties"
        while rid in ids:
            rid += "_"
        ET.SubElement(relationships, f"{{{REL}}}Relationship", {"Id": rid, "Type": CUSTOM_REL, "Target": "docProps/custom.xml"})
        parts["_rels/.rels"] = ET.tostring(relationships, encoding="utf-8", xml_declaration=True)
    types = xml(parts["[Content_Types].xml"])
    custom_types = [t for t in types if t.attrib.get("PartName") == "/docProps/custom.xml"]
    if custom_types and (len(custom_types) != 1 or custom_types[0].attrib.get("ContentType") != CUSTOM_TYPE):
        fail()
    if not custom_types:
        ET.SubElement(types, f"{{{CT}}}Override", {"PartName": "/docProps/custom.xml", "ContentType": CUSTOM_TYPE})
        parts["[Content_Types].xml"] = ET.tostring(types, encoding="utf-8", xml_declaration=True)
    original_png = Path(__file__).with_name("rufa-badge.png").read_bytes()
    original_svg = Path(__file__).with_name("rufa-badge.svg").read_bytes()
    for name, body in list(parts.items()):
        if "/media/" not in name:
            continue
        if body == original_png or name.lower().endswith(".png") and b"RufaBadge\0" in body:
            parts[name] = stamp_png(body, authors)
        elif body == original_svg or name.lower().endswith(".svg") and b"rufa-badge-authorship" in body:
            parts[name] = stamp_svg(body, authors)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as target:
        target.comment = archive.comment
        for info in archive.infolist():
            target.writestr(info, parts.pop(info.filename))
        for name, body in parts.items():
            target.writestr(name, body, compress_type=zipfile.ZIP_DEFLATED)
    archive.close()
    return output.getvalue()


def pdf_open(data):
    import pymupdf as fitz
    fitz.TOOLS.mupdf_display_errors(False)
    fitz.TOOLS.mupdf_display_warnings(False)
    document = fitz.open(stream=data, filetype="pdf")
    if document.is_encrypted or document.get_sigflags() > 0:
        document.close()
        fail("不能修改加密或已签名 PDF 的徽章属性。")
    return document


def pdf_authors(document):
    kind, value = document.xref_get_key(document.pdf_catalog(), KEY)
    if kind == "null":
        return []
    if kind != "string":
        fail()
    return decode(value)


def read_authors(data, suffix):
    if suffix == ".png":
        return png_authors(data)
    if suffix == ".svg":
        return svg_authors(data)
    if suffix in (".html", ".htm", ".md", ".markdown"):
        return text_authors(data)
    if suffix in (".docx", ".xlsx", ".pptx"):
        archive, parts = office_parts(data)
        try:
            return office_authors(parts)
        finally:
            archive.close()
    if suffix == ".pdf":
        with pdf_open(data) as document:
            return pdf_authors(document)
    fail("暂不支持此文件格式的徽章属性，请保留原文件和徽章资源。")


def stamp(data, suffix, authors):
    if read_authors(data, suffix) == authors:
        return data
    if suffix == ".png":
        return stamp_png(data, authors)
    if suffix == ".svg":
        return stamp_svg(data, authors)
    if suffix in (".html", ".htm", ".md", ".markdown"):
        return stamp_text(data, authors)
    if suffix in (".docx", ".xlsx", ".pptx"):
        return stamp_office(data, authors)
    if suffix == ".pdf":
        import pymupdf as fitz
        with pdf_open(data) as document:
            document.xref_set_key(document.pdf_catalog(), KEY, fitz.get_pdf_str(payload(authors).decode()))
            return document.tobytes(garbage=0, deflate=False, no_new_id=True, encryption=fitz.PDF_ENCRYPT_KEEP)
    fail()


def snapshot(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_size > MAX_FILE:
        fail("只支持 256 MB 以内的普通文件。")
    parents = []
    for parent in path.parents:
        if parent.is_symlink() or parent.is_junction():
            fail("不能修改重定向路径中的文件。")
        parent_info = parent.stat()
        parents.append((parent_info.st_dev, parent_info.st_ino))
    with path.open("rb") as source:
        data = source.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        fail("文件超过可处理大小，未修改。")
    identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, hashlib.sha256(data).digest(), tuple(parents))
    return data, identity, info


def windows_path(path):
    value = str(path)
    return "\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value


def protect_temporary(source, destination):
    """An empty staging file must inherit the target DACL before any bytes."""
    api = ctypes.WinDLL("advapi32", use_last_error=True)
    get = api.GetFileSecurityW
    get.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)]
    get.restype = ctypes.c_int
    set_security = api.SetFileSecurityW
    set_security.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_void_p]
    set_security.restype = ctypes.c_int
    needed = ctypes.c_ulong()
    get(windows_path(source), 4, None, 0, ctypes.byref(needed))
    if not needed.value or needed.value > MAX_META:
        fail("不能读取原文件权限，未写入徽章属性。")
    descriptor = ctypes.create_string_buffer(needed.value)
    if not get(windows_path(source), 4, descriptor, len(descriptor), ctypes.byref(needed)) or not set_security(windows_path(destination), 0x80000004, descriptor):
        fail("不能保护暂存文件权限，未写入徽章属性。")


def publish(target, temporary):
    if os.name == "nt":
        api = ctypes.WinDLL("kernel32", use_last_error=True).ReplaceFileW
        api.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_void_p]
        api.restype = ctypes.c_int
        if not api(windows_path(target), windows_path(temporary), None, 0, None, None):
            fail("文件正在使用或无法保存徽章属性，原文件已保留。")
    else:
        os.replace(temporary, target)


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def run(request):
    if not isinstance(request, dict) or request.get("operation") not in ("read", "stamp"):
        fail("无效的徽章操作。")
    path = Path(request["path"])
    if not path.is_absolute():
        fail("徽章工具需要完整文件路径。")
    data, identity, info = snapshot(path)
    authors = read_authors(data, path.suffix.lower())
    if request["operation"] == "read":
        return {"authors": authors, "format": path.suffix.lower()[1:]}
    current = username(request.get("username"))
    sources = request.get("sources", [])
    if not isinstance(sources, list) or len(sources) > 32:
        fail("参考文件数量无效。")
    checks = [(path, identity)]
    for source in sources:
        source = Path(source)
        if not source.is_absolute():
            fail()
        source_data, source_identity, _ = snapshot(source)
        authors = merge(authors, read_authors(source_data, source.suffix.lower()))
        checks.append((source, source_identity))
    authors = merge(authors, [current])
    result = stamp(data, path.suffix.lower(), authors)
    temporary = None
    try:
        if result != data:
            handle, temporary_name = tempfile.mkstemp(prefix=".rufa-badge-", suffix=".tmp", dir=path.parent)
            temporary = Path(temporary_name)
            with os.fdopen(handle, "wb") as output:
                if os.name == "nt":
                    protect_temporary(path, temporary)
                output.write(result)
                output.flush()
                os.fsync(output.fileno())
            if os.name != "nt":
                temporary.chmod(stat.S_IMODE(info.st_mode))
        if request.get("deferPublish") is not True:
            fail("徽章写入必须由当前已验证账号确认发布。")
        emit({"ready": True})
        permission = json.loads(sys.stdin.readline(MAX_META))
        if permission != {"publish": True}:
            fail("徽章写入已取消。")
        for source, expected in checks:
            if snapshot(source)[1] != expected:
                fail("文件在处理期间已变化，未覆盖，请重试。")
        if temporary:
            publish(path, temporary)
        return {"authors": authors, "format": path.suffix.lower()[1:], "changed": result != data}
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        emit(run(json.loads(sys.stdin.readline(MAX_META))))
    except Exception as error:
        # Never forward third-party parser errors, paths, document text or stdin.
        message = str(error) if isinstance(error, BadgeError) else "无法处理徽章属性，已保留原文件。"
        print(json.dumps({"error": message}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
