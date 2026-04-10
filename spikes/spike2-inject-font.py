"""
Spike 2: Inject a TTF font into a docx-js-generated DOCX via raw OOXML manipulation.

OOXML font embedding structure:
  - Font binary goes in word/fonts/<name>.ttf
  - word/fontTable.xml gets a <w:font> entry with <w:embedRegular r:id="rIdFontX"/>
  - word/_rels/fontTable.xml.rels maps rIdFontX -> fonts/<name>.ttf
  - [Content_Types].xml gets a Default entry for ttf extension
"""

import zipfile
import os
import sys
import shutil
import xml.etree.ElementTree as ET
from io import BytesIO

BASE_DOCX = "spikes/spike2-base.docx"
TTF_FILE = "spikes/Tinos-Regular.ttf"
OUT_DOCX = "spikes/spike2-embedded.docx"

# OOXML namespaces
NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}

# Register namespaces so ET doesn't mangle prefixes
for prefix, uri in NS.items():
    ET.register_namespace(prefix if prefix != "ct" else "", uri)
# Also register common namespaces that appear in DOCX
ET.register_namespace("", "http://schemas.openxmlformats.org/package/2006/content-types")
ET.register_namespace("mc", "http://schemas.openxmlformats.org/markup-compatibility/2006")
ET.register_namespace("o", "urn:schemas-microsoft-com:office:office")
ET.register_namespace("m", "http://schemas.openxmlformats.org/officeDocument/2006/math")
ET.register_namespace("v", "urn:schemas-microsoft-com:vml")
ET.register_namespace("wp", "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing")
ET.register_namespace("w10", "urn:schemas-microsoft-com:office:word")
ET.register_namespace("w14", "http://schemas.microsoft.com/office/word/2010/wordml")
ET.register_namespace("w15", "http://schemas.microsoft.com/office/word/2012/wordml")


def read_xml_from_zip(zf, path):
    """Read and parse XML from a zip entry."""
    data = zf.read(path)
    return ET.fromstring(data)


def xml_to_bytes(root):
    """Serialize an ElementTree root to bytes with XML declaration."""
    return ET.tostring(root, encoding="UTF-8", xml_declaration=True)


def update_content_types(root):
    """Add TTF content type if not already present."""
    ct_ns = "http://schemas.openxmlformats.org/package/2006/content-types"
    # Check if ttf Default already exists
    for default in root.findall(f"{{{ct_ns}}}Default"):
        if default.get("Extension") == "ttf":
            print("  [Content_Types] TTF extension already registered")
            return

    el = ET.SubElement(root, f"{{{ct_ns}}}Default")
    el.set("Extension", "ttf")
    el.set("ContentType", "application/x-font-ttf")
    print("  [Content_Types] Added TTF default content type")

    # Also ensure fontTable.xml has an Override if not present
    has_font_table_override = False
    for override in root.findall(f"{{{ct_ns}}}Override"):
        if override.get("PartName") == "/word/fontTable.xml":
            has_font_table_override = True
            break

    if not has_font_table_override:
        el2 = ET.SubElement(root, f"{{{ct_ns}}}Override")
        el2.set("PartName", "/word/fontTable.xml")
        el2.set("ContentType", "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml")
        print("  [Content_Types] Added fontTable.xml override")


def create_or_update_font_table(zf, font_name, rel_id):
    """Create or update word/fontTable.xml with font embedding entry."""
    w = NS["w"]
    r = NS["r"]

    try:
        root = read_xml_from_zip(zf, "word/fontTable.xml")
        print("  [fontTable.xml] Found existing fontTable.xml")
    except KeyError:
        # Create a new fontTable.xml
        root = ET.Element(f"{{{w}}}fonts")
        root.set(f"xmlns:r", r)
        print("  [fontTable.xml] Created new fontTable.xml")

    # Check if font entry already exists
    for font_el in root.findall(f"{{{w}}}font"):
        if font_el.get(f"{{{w}}}name") == font_name:
            print(f"  [fontTable.xml] Font '{font_name}' already exists, updating")
            # Add embedRegular if not present
            embed = font_el.find(f"{{{w}}}embedRegular")
            if embed is None:
                embed = ET.SubElement(font_el, f"{{{w}}}embedRegular")
            embed.set(f"{{{r}}}id", rel_id)
            # fontKey is a GUID used for obfuscation; we use a dummy one
            embed.set(f"{{{w}}}fontKey", "{00000000-0000-0000-0000-000000000000}")
            return root

    # Create new font entry
    font_el = ET.SubElement(root, f"{{{w}}}font")
    font_el.set(f"{{{w}}}name", font_name)

    # Add panose (optional but Word expects it)
    panose = ET.SubElement(font_el, f"{{{w}}}panose1")
    panose.set(f"{{{w}}}val", "02020603050405020304")  # Times-like panose

    # Add charset
    charset = ET.SubElement(font_el, f"{{{w}}}charset")
    charset.set(f"{{{w}}}val", "00")

    # Add family
    family = ET.SubElement(font_el, f"{{{w}}}family")
    family.set(f"{{{w}}}val", "roman")

    # Add pitch
    pitch = ET.SubElement(font_el, f"{{{w}}}pitch")
    pitch.set(f"{{{w}}}val", "variable")

    # Add embedRegular
    embed = ET.SubElement(font_el, f"{{{w}}}embedRegular")
    embed.set(f"{{{r}}}id", rel_id)
    embed.set(f"{{{w}}}fontKey", "{00000000-0000-0000-0000-000000000000}")

    print(f"  [fontTable.xml] Added font entry for '{font_name}' with rel={rel_id}")
    return root


def create_or_update_font_table_rels(zf, rel_id, font_target):
    """Create or update word/_rels/fontTable.xml.rels."""
    rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    ET.register_namespace("", rel_ns)

    try:
        root = read_xml_from_zip(zf, "word/_rels/fontTable.xml.rels")
        print("  [fontTable.xml.rels] Found existing rels file")
    except KeyError:
        root = ET.Element(f"{{{rel_ns}}}Relationships")
        print("  [fontTable.xml.rels] Created new rels file")

    # Check if relationship already exists
    for rel in root.findall(f"{{{rel_ns}}}Relationship"):
        if rel.get("Id") == rel_id:
            print(f"  [fontTable.xml.rels] Relationship {rel_id} already exists")
            return root

    rel_el = ET.SubElement(root, f"{{{rel_ns}}}Relationship")
    rel_el.set("Id", rel_id)
    rel_el.set("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font")
    rel_el.set("Target", font_target)

    print(f"  [fontTable.xml.rels] Added relationship {rel_id} -> {font_target}")
    return root


def ensure_font_table_in_document_rels(zf):
    """Ensure word/_rels/document.xml.rels references fontTable.xml."""
    rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    ET.register_namespace("", rel_ns)

    root = read_xml_from_zip(zf, "word/_rels/document.xml.rels")

    font_table_type = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable"
    for rel in root.findall(f"{{{rel_ns}}}Relationship"):
        if rel.get("Type") == font_table_type:
            print(f"  [document.xml.rels] fontTable relationship already exists (Id={rel.get('Id')})")
            return root

    # Find next available rId
    existing_ids = set()
    for rel in root.findall(f"{{{rel_ns}}}Relationship"):
        rid = rel.get("Id", "")
        if rid.startswith("rId"):
            try:
                existing_ids.add(int(rid[3:]))
            except ValueError:
                pass
    next_id = max(existing_ids, default=0) + 1

    rel_el = ET.SubElement(root, f"{{{rel_ns}}}Relationship")
    rel_el.set("Id", f"rId{next_id}")
    rel_el.set("Type", font_table_type)
    rel_el.set("Target", "fontTable.xml")

    print(f"  [document.xml.rels] Added fontTable relationship as rId{next_id}")
    return root


def main():
    if not os.path.exists(BASE_DOCX):
        print(f"ERROR: {BASE_DOCX} not found. Run spike2-font-embed.mjs first.")
        sys.exit(1)

    if not os.path.exists(TTF_FILE):
        print(f"ERROR: {TTF_FILE} not found. Run WOFF2->TTF conversion first.")
        sys.exit(1)

    ttf_data = open(TTF_FILE, "rb").read()
    print(f"TTF font size: {len(ttf_data)} bytes")

    font_name = "Tinos"
    font_filename = "Tinos-Regular.ttf"
    font_zip_path = f"word/fonts/{font_filename}"
    rel_id = "rIdFont1"

    print(f"\n--- Injecting {font_name} into DOCX ---")

    # Read original DOCX
    with zipfile.ZipFile(BASE_DOCX, "r") as zf_in:
        # List contents for debugging
        print("\nOriginal DOCX contents:")
        for info in zf_in.infolist():
            print(f"  {info.filename} ({info.file_size} bytes)")

        # 1. Update [Content_Types].xml
        print("\nStep 1: Update [Content_Types].xml")
        content_types = read_xml_from_zip(zf_in, "[Content_Types].xml")
        update_content_types(content_types)

        # 2. Create/update fontTable.xml
        print("\nStep 2: Create/update word/fontTable.xml")
        font_table = create_or_update_font_table(zf_in, font_name, rel_id)

        # 3. Create/update fontTable.xml.rels
        print("\nStep 3: Create/update word/_rels/fontTable.xml.rels")
        font_table_rels = create_or_update_font_table_rels(zf_in, rel_id, f"fonts/{font_filename}")

        # 4. Ensure document.xml.rels references fontTable.xml
        print("\nStep 4: Ensure document.xml.rels references fontTable.xml")
        doc_rels = ensure_font_table_in_document_rels(zf_in)

        # 5. Repack everything
        print("\nStep 5: Repack DOCX")

        modified_files = {
            "[Content_Types].xml": xml_to_bytes(content_types),
            "word/fontTable.xml": xml_to_bytes(font_table),
            "word/_rels/fontTable.xml.rels": xml_to_bytes(font_table_rels),
            "word/_rels/document.xml.rels": xml_to_bytes(doc_rels),
        }

        with zipfile.ZipFile(OUT_DOCX, "w", zipfile.ZIP_DEFLATED) as zf_out:
            # Copy all original entries, replacing modified ones
            for item in zf_in.infolist():
                if item.filename in modified_files:
                    zf_out.writestr(item.filename, modified_files[item.filename])
                    print(f"  Replaced: {item.filename}")
                    del modified_files[item.filename]
                else:
                    zf_out.writestr(item, zf_in.read(item.filename))
                    print(f"  Copied:   {item.filename}")

            # Write new files that didn't exist in original
            for filename, data in modified_files.items():
                zf_out.writestr(filename, data)
                print(f"  Added:    {filename}")

            # Add the font file
            zf_out.writestr(font_zip_path, ttf_data)
            print(f"  Added:    {font_zip_path} ({len(ttf_data)} bytes)")

    # Verify
    print(f"\n--- Verification ---")
    out_size = os.path.getsize(OUT_DOCX)
    print(f"Output DOCX size: {out_size} bytes (base was {os.path.getsize(BASE_DOCX)} bytes)")

    with zipfile.ZipFile(OUT_DOCX, "r") as zf:
        print("\nEmbedded DOCX contents:")
        for info in zf.infolist():
            print(f"  {info.filename} ({info.file_size} bytes)")

        # Verify font file exists
        assert font_zip_path in zf.namelist(), f"Font file {font_zip_path} not found in DOCX!"
        font_in_zip = zf.read(font_zip_path)
        assert len(font_in_zip) == len(ttf_data), "Font file size mismatch!"
        print(f"\nFont file verified: {font_zip_path} ({len(font_in_zip)} bytes)")

        # Print key XML for inspection
        print("\n--- [Content_Types].xml ---")
        print(zf.read("[Content_Types].xml").decode("utf-8"))

        print("\n--- word/fontTable.xml ---")
        print(zf.read("word/fontTable.xml").decode("utf-8"))

        print("\n--- word/_rels/fontTable.xml.rels ---")
        print(zf.read("word/_rels/fontTable.xml.rels").decode("utf-8"))

        print("\n--- word/_rels/document.xml.rels ---")
        print(zf.read("word/_rels/document.xml.rels").decode("utf-8"))

        # Validate ZIP integrity
        bad = zf.testzip()
        if bad is None:
            print("\nZIP integrity: PASS (no corrupt entries)")
        else:
            print(f"\nZIP integrity: FAIL (first bad file: {bad})")

    print("\n=== SPIKE 2 COMPLETE ===")


if __name__ == "__main__":
    main()
