#!/usr/bin/env python3
"""Rewrites the Rust crate section of THIRD-PARTY-NOTICES.md from `cargo metadata --locked`.

Usage (from the repo root, with cargo on PATH):  python3 scripts/gen-notices.py

For each target triple of the release workflow it asks cargo for the dependency graph of that platform
(`--filter-platform`), follows only normal and build dependency edges (never dev dependencies) from the app crate, and
takes the union. Everything else in the file (frontend table, notes, trademarks) is left alone.
"""
import datetime, json, re, subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILE = ROOT / "THIRD-PARTY-NOTICES.md"
TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]


def crates_for(target):
    out = subprocess.run(
        ["cargo", "metadata", "--locked", "--format-version", "1", "--filter-platform", target,
         "--manifest-path", str(ROOT / "src-tauri" / "Cargo.toml")],
        check=True, capture_output=True, text=True).stdout
    meta = json.loads(out)
    pk = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    root = meta["resolve"]["root"]
    seen, todo = set(), [root]
    while todo:
        i = todo.pop()
        if i in seen:
            continue
        seen.add(i)
        for d in nodes[i]["deps"]:
            kinds = {k["kind"] for k in d["dep_kinds"]}  # None = normal, "build", "dev"
            if kinds & {None, "build"}:
                todo.append(d["pkg"])
    seen.discard(root)
    return {(pk[i]["name"], pk[i]["version"]): pk[i].get("license") or ("see " + str(pk[i].get("license_file"))) for i in seen}


def main():
    allc, per = {}, {}
    for t in TARGETS:
        c = crates_for(t)
        per[t] = len(c)
        allc.update(c)
    rows = sorted(allc.items(), key=lambda kv: (kv[0][0].lower(), kv[0][1]))
    licences = sorted(set(allc.values()))
    mpl = [f"{n} {v}" for (n, v), l in rows if "MPL-2.0" in l]
    today = datetime.date.today().isoformat()
    sec = [
        f"## Rust crates (compiled into the app binary), {len(rows)} in total", "",
        f"Generated on {today} with `python3 scripts/gen-notices.py`, which runs `cargo metadata --locked --format-version 1 --filter-platform <target>` "
        "(from `src-tauri/Cargo.lock`) for each release target, follows normal and build dependencies only (no dev dependencies) from the app crate, "
        "and takes the union, one row per crate version. Targets: " + ", ".join(f"{t} ({per[t]} crates)" for t in TARGETS) +
        ". The licence is the SPDX expression each crate declares. The full licence texts are in `THIRD-PARTY-LICENSES.txt` (built by `python3 scripts/gen-licenses.py`).", "",
        "Licences present: " + ", ".join(licences) + ".", "",
        "Notes:",
        "- Dual or multi licensed crates (`A OR B`) may be used under either option. This app uses them under the permissive",
        "  option (MIT, Apache-2.0, Zlib, BSD or Unlicense). In particular `r-efi` is offered as `MIT OR Apache-2.0 OR LGPL-2.1-or-later`; the LGPL option is not used. (Today `r-efi` is in `Cargo.lock` for UEFI targets only and appears in none of the release targets, so it is not in the table below.)",
        "- MPL-2.0 crates (" + ", ".join(mpl) + ") are used unmodified. MPL-2.0 is a file-level licence: their source stays available at https://crates.io/crates/<name> and https://github.com/servo (cssparser, selectors, dtoa-short) and https://github.com/soc/option-ext. If you ever modify one of those files, publish the modified file under MPL-2.0.",
        "- Crates marked Apache-2.0 only (for example `tao`, `sync_wrapper`) require that the Apache licence text and any NOTICE files are included with distributions.",
        "- Not all crates are compiled on every operating system (for example the Linux D-Bus and GTK crates are not in the Windows build). Build dependencies (build scripts and what they use) are listed too, although they are not part of the finished binary.",
        "", "| Crate | Version | Licence |", "|---|---|---|",
    ] + [f"| {n} | {v} | {l} |" for (n, v), l in rows] + [""]
    text = FILE.read_text()
    a = text.index("## Rust crates")
    b = text.index("## Trademarks")
    text = text[:a] + "\n".join(sec) + "\n" + text[b:]
    text = re.sub(r"This list was generated on .*?run `cargo about` or `cargo license` before a real release \(not run here\)\.",
                  "The frontend table was written on 2026-10-09 from the installed `node_modules` package files; the Rust section was regenerated on "
                  f"{today} (see below). Each row lists the SPDX licence the package declares. It is not legal advice. The full licence texts of the Rust crates and the npm "
                  "packages are in `THIRD-PARTY-LICENSES.txt` (built by `python3 scripts/gen-licenses.py`); a few crates ship no licence file and are listed at its end.",
                  text, flags=re.S)
    FILE.write_text(text)
    print(len(rows), per)


main()
