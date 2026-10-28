#!/usr/bin/env python3
"""Messung Speicher und CPU im Leerlauf, nur macOS: Hülle mit Profil os gegen Safari, beide zeigen dieselbe lokale Leerlaufseite
(testserver.py os, Pfad /ruhig: 200 Listeneinträge, ein Takt je Sekunde, ein kleiner Abruf je Sekunde). Es wird nichts angemeldet, kein Netz benutzt.

Gemessen wird die Summe aller beteiligten Prozesse:
  Hülle  = Hauptprozess + alle NEU entstandenen com.apple.WebKit.*-Prozesse (WebContent, Networking, GPU), die nach dem Start der Hülle auftauchen
  Safari = Zuwachs des Safari-Hauptprozesses + alle NEU entstandenen com.apple.WebKit.*-Prozesse nach dem Öffnen eines neuen Tabs
Speicher = physischer Footprint (`footprint`, was Aktivitätsanzeige „Speicher“ nennt; geteilte Systembibliotheken zählen nicht doppelt wie bei RSS).
CPU = Zuwachs der CPU-Zeit (`ps cputime`) geteilt durch die Messdauer (100 % = ein Kern). Mittelwert über die Messdauer (Vorgabe 60 s, Probe alle 5 s).

Grenzen (stehen auch im Bericht): andere Programme laufen währenddessen auf demselben Mac; WebKit-Hilfsprozesse anderer Apps, die im selben Zeitraum
neu starten, würden fälschlich mitgezählt (die Prozessliste wird vor und nach dem Start verglichen und angezeigt); Safari wird über Apple Events bedient
(ein neuer Tab im bestehenden Fenster, am Ende geschlossen); Chrome ist auf diesem Mac nicht installiert und wird nicht verglichen.

Aufruf:  python3 tools/messung_os.py APP [--dauer 60] [--nur huelle|safari]    APP = Pfad der gebauten .app (Release)
"""
import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

HIER = Path(__file__).resolve().parent
PORT = 18663


def ps_liste():
    r = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True)
    out = []
    for z in r.stdout.splitlines():
        t = z.strip().split(None, 2)
        if len(t) == 3 and t[0].isdigit():
            out.append((int(t[0]), int(t[1]), t[2]))
    return out


def webkit_pids():
    return {p for p, _, c in ps_liste() if "com.apple.WebKit." in c}


def start_zeit(pid):
    """Startzeit eines Prozesses in Sekunden (Unix), aus `ps -o lstart`."""
    r = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, env=dict(os.environ, LC_ALL="C"))
    try:
        return time.mktime(time.strptime(r.stdout.strip(), "%a %b %d %H:%M:%S %Y"))
    except ValueError:
        return None


def footprint_mb(pid):
    r = subprocess.run(["footprint", "-p", str(pid)], capture_output=True, text=True)
    m = re.search(r"Footprint:\s*([\d.]+)\s*(KB|MB|GB|B)\b", r.stdout)
    if not m:
        return None
    zahl, einheit = float(m.group(1)), m.group(2)
    return zahl * {"B": 1 / 1048576, "KB": 1 / 1024, "MB": 1, "GB": 1024}[einheit]


def cpu_s(pid):
    r = subprocess.run(["ps", "-o", "cputime=", "-p", str(pid)], capture_output=True, text=True)
    t = r.stdout.strip()
    if not t:
        return None
    tage = 0
    if "-" in t:
        d, t = t.split("-", 1)
        tage = int(d)
    teile = [float(x) for x in t.split(":")]
    while len(teile) < 3:
        teile.insert(0, 0.0)
    return tage * 86400 + teile[0] * 3600 + teile[1] * 60 + teile[2]


def name(pid):
    for p, _, c in ps_liste():
        if p == pid:
            return c.split("/")[-1][:60] if "WebKit" in c else Path(c.split(" ")[0]).name
    return "?"


def messen(pids, dauer, takt=5, abzug_mb=0.0, abzug_cpu=0.0):
    """Mittel der Footprint-Summe und der CPU-Auslastung über `dauer` Sekunden. Prozesse, die enden, zählen ab dann nicht mehr."""
    proben = []
    cpu0 = {p: cpu_s(p) for p in pids}
    t0 = time.time()
    while True:
        summe = sum(v for v in (footprint_mb(p) for p in pids) if v)
        proben.append(summe - abzug_mb)
        if time.time() - t0 >= dauer:
            break
        time.sleep(takt)
    verstrichen = time.time() - t0
    cpu1 = {p: cpu_s(p) for p in pids}
    zuwachs = sum(max(0.0, cpu1[p] - cpu0[p]) for p in pids if cpu0.get(p) is not None and cpu1.get(p) is not None)
    return {"mb_mittel": round(sum(proben) / len(proben), 1), "mb_min": round(min(proben), 1), "mb_max": round(max(proben), 1),
            "proben": len(proben), "cpu_prozent": round(100 * zuwachs / verstrichen - abzug_cpu, 2), "sekunden": round(verstrichen)}


def server_starten():
    return subprocess.Popen([sys.executable, str(HIER / "testserver.py"), "os", "--port", str(PORT)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def messe_huelle(app, dauer):
    daten = Path("/private/tmp/fyos-shell-d0-e2e/messung-daten")
    if daten.exists():
        shutil.rmtree(daten)
    daten.mkdir(parents=True)
    (daten / "einstellungen.json").write_text(json.dumps({"schema": 1, "start_url": f"http://127.0.0.1:{PORT}/ruhig"}), encoding="utf-8")
    tmp = Path("/private/tmp/fyos-shell-d0-e2e/messung-tmp")
    tmp.mkdir(parents=True, exist_ok=True)
    vorher = webkit_pids()
    env = dict(os.environ, FYOS_SHELL_DATEN=str(daten), TMPDIR=str(tmp))
    p = subprocess.Popen([str(Path(app) / "Contents" / "MacOS" / "fyos-shell")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        t_start = start_zeit(p.pid) or time.time()
        time.sleep(20)  # laden, Probe, Fenster, Seite laufen lassen; erst dann messen
        # Nur WebKit-Prozesse, die innerhalb von 8 s nach dem Start der Hülle entstanden sind (sonst würden fremde Programme mitgezählt)
        neu = sorted(x for x in webkit_pids() - vorher if (start_zeit(x) or 0) - t_start <= 8)
        pids = [p.pid] + neu
        print("Hülle: Prozesse", [(x, name(x)) for x in pids], flush=True)
        return messen(pids, dauer) | {"prozesse": [name(x) for x in pids]}
    finally:
        p.send_signal(signal.SIGTERM)
        try:
            p.wait(timeout=30)
        except subprocess.TimeoutExpired:
            p.kill()


def safari_pid():
    for pid, _, c in ps_liste():
        if c.endswith("/Safari.app/Contents/MacOS/Safari"):
            return pid
    return None


def osa(skript):
    return subprocess.run(["osascript", "-e", skript], capture_output=True, text=True, timeout=30)


def messe_safari(dauer):
    url = f"http://127.0.0.1:{PORT}/ruhig"
    war_offen = safari_pid() is not None
    if not war_offen:
        subprocess.run(["open", "-a", "Safari"])
        time.sleep(5)
    spid = safari_pid()
    if spid is None:
        return {"fehler": "Safari lässt sich nicht starten"}
    time.sleep(3)
    sf0 = footprint_mb(spid) or 0.0
    vorher = webkit_pids()
    r = osa(f'tell application "Safari" to tell window 1 to set current tab to (make new tab with properties {{URL:"{url}"}})')
    if r.returncode != 0:
        return {"fehler": "Safari-Tab nicht zu öffnen (Automatisierung nicht erlaubt?): " + r.stderr.strip()[:200]}
    try:
        time.sleep(20)
        neu = sorted(webkit_pids() - vorher)
        sf_mb = (footprint_mb(spid) or 0.0) - sf0
        pids = neu
        print("Safari: neue Prozesse", [(x, name(x)) for x in pids], "Zuwachs Safari-Hauptprozess %.1f MB" % sf_mb, flush=True)
        # Hauptprozess: Zuwachs wird als fester Abzug-/Zuschlagswert eingerechnet (die Probe misst nur die neuen WebKit-Prozesse)
        m = messen(pids, dauer)
        m["mb_mittel"] = round(m["mb_mittel"] + sf_mb, 1)
        m["safari_hauptprozess_zuwachs_mb"] = round(sf_mb, 1)
        m["prozesse"] = [name(x) for x in pids]
        return m
    finally:
        osa(f'tell application "Safari" to close (every tab of every window whose URL contains ":{PORT}/ruhig")')
        if not war_offen:
            osa('tell application "Safari" to quit')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("app")
    p.add_argument("--dauer", type=int, default=60)
    p.add_argument("--nur", choices=["huelle", "safari"])
    a = p.parse_args()
    if sys.platform != "darwin":
        sys.exit("nur macOS")
    server = server_starten()
    time.sleep(1.5)
    erg = {}
    try:
        if a.nur != "safari":
            erg["huelle_os"] = messe_huelle(a.app, a.dauer)
            print(json.dumps(erg["huelle_os"], ensure_ascii=False), flush=True)
        if a.nur != "huelle":
            erg["safari_tab"] = messe_safari(a.dauer)
            print(json.dumps(erg["safari_tab"], ensure_ascii=False), flush=True)
    finally:
        server.terminate()
    print(json.dumps(erg, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
