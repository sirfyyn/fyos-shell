# Vorschlag für das Studio-Projekt: „Updates kommen über die App“

**Nur ein Vorschlag, nicht im Studio-Repo eingespielt oder gepusht.** `0001-verwaltet-von-der-app.patch` ist ein `git diff` gegen den Tag `v0.4.1` von `sirfyyn/fle-studio`
(Commit `6d5b01e`); er ist klein (4 Dateien, 57 Zeilen) und ändert nichts, solange die Umgebungsvariable nicht gesetzt ist.

## Was er tut

Die Hülle `fyos-shell` liefert das Studio in ihrem Programmpaket mit (Python-Bündel, siehe `docs/current/FYOS-SHELL-PYTHON-BUENDEL.md`) und setzt für den Studio-Server
`FLE_STUDIO_MANAGED_BY=fyos-shell`. Mit dem Patch gilt dann:

- `fle_studio_updater.updates.detect_install` meldet `{"kind": "managed", "source": "fyos-shell", …}`; `advice` antwortet `can_auto: false` mit dem Grund
  „Updates come through the app (fyos-shell). Update the app; it replaces this copy of FLE Studio.“ und ohne Kommando. Der Update-Knopf in den Einstellungen zeigt diesen Grund,
  `Updates.apply` verweigert mit demselben Text (kein `uv`, kein `pip`, kein Eingriff in das Paket).
- `fle-studio update` (Kommandozeile) druckt denselben Satz und endet mit Ausgang 0, statt zu installieren.
- Ohne die Variable bleibt alles, wie es ist (getestet).

## Geprüft

Im Klon des Tags v0.4.1 mit dem Patch: die neuen Tests (`tests/plugins/test_updates.py`: Erkennung, Auskunft, `apply` verweigert, ohne Marke unverändert;
`tests/test_selfupdate.py`: Kommandozeile) und die gesamte Testsuite ohne `tests/e2e`: **713 bestanden, 3 übersprungen**. Ein Eintrag in `CHANGELOG.md` gehört dazu, sobald
das Studio-Projekt eine Version dafür festlegt (der Test `test_changelog_matches_the_version` verlangt, dass der oberste Eintrag der Version entspricht; deshalb steht keiner im Patch).

## Einspielen (Studio-Projekt)

```
git checkout -b verwaltet-von-der-app v0.4.1
git apply /pfad/zu/0001-verwaltet-von-der-app.patch
python -m pytest tests -q --ignore=tests/e2e
```

Bis dahin verhindert die Hülle das Selbst-Update auf andere Weise nicht: das Paket ist zwar nicht schreibbar gedacht (`PYTHONDONTWRITEBYTECODE`), ein Klick auf „Update“ im
ungepatchten Studio würde aber scheitern (kein `uv`, keine Quelle) und eine Fehlermeldung zeigen, nicht das Paket verändern. [Vermutet; nicht ausprobiert]
