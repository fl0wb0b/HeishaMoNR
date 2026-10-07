#!/usr/bin/env python3
"""List the visible static strings of the given dashboard tabs (input for tools/de_translations.json)."""
import json, re, sys, collections

SCOPE_NAMES = ["Settings", "Pumpspeed", "CCC", "RTC", "SoftStart", "Scheduler", "SYSTEM"]
TAG = re.compile(r"(<[^>]+>)")


def template_texts(html):
    """Visible text segments of an HTML snippet (style/script blocks skipped)."""
    html = re.sub(r"<(style|script)\b.*?</\1>", "", html, flags=re.S | re.I)
    out = []
    for tok in TAG.split(html):
        if tok.startswith("<"):
            continue
        t = tok.strip()
        if t and re.search(r"[A-Za-z]{2}", t) and not re.fullmatch(r"(\{\{[^}]*\}\}\s*)+", t):
            out.append(re.sub(r"\s+", " ", t))
    return out


def strings_of(n):
    t = n["type"]
    s = []
    for k in ("label", "title", "tooltip"):
        v = n.get(k)
        if isinstance(v, str) and re.search(r"[A-Za-z]{2}", re.sub(r"\{\{[^}]*\}\}|<[^>]+>", "", v)):
            s.append((k, v))
    if t in ("ui_text", "ui_gauge", "ui_numeric", "ui_slider") :
        for k in ("format", "units"):
            v = n.get(k)
            if isinstance(v, str) and re.search(r"[A-Za-z]{2}", re.sub(r"\{\{[^}]*\}\}|<[^>]+>", "", v)):
                s.append((k, v))
    if t == "ui_dropdown":
        for o in n.get("options", []):
            if isinstance(o.get("label"), str) and re.search(r"[A-Za-z]{2}", o["label"]):
                s.append(("option", o["label"]))
    if t == "ui_form":
        for o in n.get("options", []):
            if isinstance(o.get("label"), str):
                s.append(("formlabel", o["label"]))
        for k in ("formValue",):
            pass
    if t == "ui_template":
        for x in template_texts(n.get("format", "")):
            s.append(("template", x))
    return s


if __name__ == "__main__":
    flows = json.load(open(sys.argv[1], encoding="utf-8"))
    tabs = {t["id"]: t["name"] for t in flows if t["type"] == "ui_tab"}
    groups = {g["id"]: g for g in flows if g["type"] == "ui_group"}
    res = collections.OrderedDict()
    for g in groups.values():
        if tabs.get(g["tab"]) in SCOPE_NAMES:
            res.setdefault(g["name"], set()).add(("group", tabs[g["tab"]]))
    for tid, tn in tabs.items():
        if tn in SCOPE_NAMES:
            res.setdefault(tn, set()).add(("tab", tn))
    for n in flows:
        g = groups.get(n.get("group"))
        if g and tabs.get(g["tab"]) in SCOPE_NAMES and n["type"].startswith("ui_"):
            for k, v in strings_of(n):
                res.setdefault(v, set()).add((k, tabs[g["tab"]]))
    json.dump({k: sorted({f"{a}@{b}" for a, b in v}) for k, v in res.items()}, open(sys.argv[2], "w"), ensure_ascii=False, indent=0)
    print(len(res), "unique strings")
