#!/usr/bin/env python3
"""List multi-word string literals of function nodes (comments skipped) and whether they sit in a comparison."""
import json, re, sys, collections

LIT = re.compile(r"""(?P<q>["'`])(?P<s>(?:\\.|(?!(?P=q)).)*)(?P=q)""")
CMP_BEFORE = re.compile(r"(==|!=|===|!==|\bcase\b|\.includes\(|\.indexOf\(|\.startsWith\(|\.endsWith\(|\.test\(|\.match\(|\.split\(|\.replace\(|\.has\(|\[)\s*$")
CMP_AFTER = re.compile(r"^\s*(==|!=|===|!==|\]|:\s*(?!\s*[\"'`]))")


def strip_comments(code):
    code = re.sub(r"/\*.*?\*/", lambda m: " " * len(m.group(0)), code, flags=re.S)
    return re.sub(r"//[^\n]*", lambda m: " " * len(m.group(0)), code)


def literals(code):
    code = strip_comments(code)
    out = []
    for m in LIT.finditer(code):
        s = m.group("s")
        if not (" " in s.strip() and len(re.findall(r"[A-Za-z]{2,}", s)) >= 2):
            continue
        before, after = code[: m.start()], code[m.end():]
        cmp_ = bool(CMP_BEFORE.search(before)) or bool(re.match(r"\s*(==|!=)", after))
        out.append((s, cmp_))
    return out


if __name__ == "__main__":
    flows = json.load(open(sys.argv[1], encoding="utf-8"))
    tabs = {t["id"]: t.get("label") for t in flows if t["type"] == "tab"}
    res = collections.OrderedDict()
    for n in flows:
        if n["type"] == "function":
            for s, c in literals(n.get("func", "")):
                e = res.setdefault(s, {"cmp": False, "where": set()})
                e["cmp"] = e["cmp"] or c
                e["where"].add((tabs.get(n.get("z")), n["id"]))
    json.dump({k: {"cmp": v["cmp"], "where": sorted(v["where"])} for k, v in res.items()}, open(sys.argv[2], "w"), ensure_ascii=False, indent=0)
    print(len(res), "unique literals;", sum(1 for v in res.values() if v["cmp"]), "in comparisons")
