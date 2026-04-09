# Agent Email

[![npm version](https://img.shields.io/npm/v/email-agent-mcp)](https://www.npmjs.com/package/email-agent-mcp)
[![npm downloads](https://img.shields.io/npm/dm/email-agent-mcp.svg)](https://npmjs.org/package/email-agent-mcp)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/UseJunior/email-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/UseJunior/email-agent-mcp/actions/workflows/ci.yml)
[![codecov](https://img.shields.io/codecov/c/github/UseJunior/email-agent-mcp/main)](https://app.codecov.io/gh/UseJunior/email-agent-mcp)
[![GitHub stargazers](https://img.shields.io/github/stars/UseJunior/email-agent-mcp?style=social)](https://github.com/UseJunior/email-agent-mcp/stargazers)
[![Socket Badge](https://socket.dev/api/badge/npm/package/email-agent-mcp)](https://socket.dev/npm/package/email-agent-mcp)
[![install size](https://img.shields.io/npm/unpacked-size/email-agent-mcp)](https://www.npmjs.com/package/email-agent-mcp)

[English](https://github.com/UseJunior/email-agent-mcp/blob/main/packages/email-agent-mcp/README.md) | [Español](https://github.com/UseJunior/email-agent-mcp/blob/main/packages/email-agent-mcp/README.es.md) | [简体中文](https://github.com/UseJunior/email-agent-mcp/blob/main/packages/email-agent-mcp/README.zh.md) | [Português (Brasil)](https://github.com/UseJunior/email-agent-mcp/blob/main/packages/email-agent-mcp/README.pt-br.md) | [Deutsch](https://github.com/UseJunior/email-agent-mcp/blob/main/packages/email-agent-mcp/README.de.md)

> **Hinweis zur Ubersetzung:** Die englische `README.md` ist die kanonische Quelle. Diese Ubersetzung kann leicht verzogert sein. Wichtige Aenderungen im englischen README sollten innerhalb von 72 Stunden uebernommen werden.

**email-agent-mcp** von [UseJunior](https://usejunior.com) -- E-Mail-Anbindung fuer KI-Agenten.

Agent Email ist ein quelloffener TypeScript-MCP-Server, der KI-Agenten sicheren Zugriff auf E-Mail ermoeglicht. Er stellt E-Mail-Operationen ueber das [Model Context Protocol](https://modelcontextprotocol.io/) fuer jede MCP-kompatible Agenten-Laufzeitumgebung bereit -- Claude Code, Gemini CLI, Cursor, Goose und weitere. Sicherheitsorientierte Standardeinstellungen sorgen dafuer, dass Agenten keine E-Mails senden koennen, bis Sie explizit eine Zulassungsliste konfigurieren.

## Warum es dieses Projekt gibt

KI-Agenten muessen E-Mails lesen, beantworten und darauf reagieren -- aber E-Mail-APIs sind komplex. OAuth-Ablaeufe, Graph-Delta-Abfragen, Gmail-Push-Benachrichtigungen, HTML-zu-Markdown-Konvertierung, Threading-Semantik -- jeder Anbieter hat seine eigenen Besonderheiten.

Agent Email kapselt diese Komplexitaet in deterministische MCP-Tools mit Sicherheitsleitplanken:

- Sende- und Empfangs-Zulassungslisten, die steuern, wen Agenten kontaktieren koennen
- Loeschen ist standardmaessig deaktiviert (erfordert explizites Opt-in)
- Fehlerbereinigung, die API-Schluessel, Dateipfade und Stack-Traces entfernt
- Body-Datei-Sandboxing mit Schutz vor Pfad-Traversierung

## Verwendung mit Claude Code

Fuegen Sie Folgendes zu `~/.claude/settings.json` oder Ihrer Projekt-Datei `.claude/settings.json` hinzu:

```json
{
  "mcpServers": {
    "email-agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "email-agent-mcp"]
    }
  }
}
```

## Verwendung mit Gemini CLI

```bash
gemini extensions install https://github.com/UseJunior/email-agent-mcp
```

## Verwendung mit Cursor

```json
// .cursor/mcp.json
{
  "mcpServers": {
    "email-agent-mcp": {
      "command": "npx",
      "args": ["-y", "email-agent-mcp"]
    }
  }
}
```

## Verwendung ueber die Kommandozeile

```bash
npx -y email-agent-mcp
```

Der interaktive Einrichtungsassistent fuehrt Sie durch die OAuth-Konfiguration und die Postfachauswahl.

## Tool-Referenz

Agent Email stellt 15 MCP-Tools bereit:

| Tool | Beschreibung | Typ |
|------|--------------|-----|
| `list_emails` | Aktuelle E-Mails mit Filteroptionen auflisten | Lesen |
| `read_email` | Vollstaendigen E-Mail-Inhalt als Markdown lesen | Lesen |
| `search_emails` | Volltextsuche ueber alle Postfaecher | Lesen |
| `get_mailbox_status` | Verbindungsstatus und Warnungen abrufen | Lesen |
| `get_thread` | Vollstaendigen Konversationskontext abrufen | Lesen |
| `send_email` | Neue E-Mail senden (durch Zulassungsliste gesteuert) | Schreiben |
| `reply_to_email` | Antwort mit RFC-konformem Threading | Schreiben |
| `create_draft` | E-Mail-Entwurf erstellen | Schreiben |
| `update_draft` | Entwurfsinhalt aktualisieren | Schreiben |
| `send_draft` | Gespeicherten Entwurf senden | Schreiben |
| `label_email` | Labels/Kategorien zuweisen | Schreiben |
| `flag_email` | E-Mails markieren/Markierung aufheben | Schreiben |
| `mark_read` | Als gelesen/ungelesen markieren | Schreiben |
| `move_to_folder` | Zwischen Ordnern verschieben | Schreiben |
| `delete_email` | Loeschen (erfordert Opt-in) | Destruktiv |

## Anbieterunterstuetzung

| Anbieter | Status | Paket |
|----------|--------|-------|
| Microsoft 365 (Graph API) | Vollstaendig unterstuetzt | `@usejunior/provider-microsoft` |
| Gmail | Unterstuetzt per manuellem Refresh-Token-Setup | `@usejunior/provider-gmail` |

Gmail funktioniert jetzt im MCP-Server ueber eine manuelle Datei unter `~/.email-agent-mcp/tokens/`. Der interaktive Gmail-Assistent ist weiterhin ein Follow-up. Siehe `packages/provider-gmail/README.md`.

## Sicherheitsstandards

Agent Email wird mit restriktiven Standardeinstellungen ausgeliefert, die Sie bei Bedarf lockern koennen:

- **Sende-Zulassungsliste**: standardmaessig leer -- Agenten koennen keine E-Mails senden, bis Sie Empfaenger hinzufuegen
- **Empfangs-Zulassungsliste**: akzeptiert standardmaessig alle -- steuert, welche Absender den Watcher ausloesen
- **Loeschen deaktiviert**: Agenten koennen keine E-Mails loeschen, es sei denn, Sie setzen `user_explicitly_requested_deletion: true`
- **Fehlerbereinigung**: API-Schluessel, Dateipfade und Stack-Traces werden aus Fehlerantworten entfernt
- **Body-Datei-Sandboxing**: kein `../`-Traversieren, keine Symlinks, Binaererkennung

## Haeufig gestellte Fragen

### Funktioniert das mit Claude Code?

Ja. Fuehren Sie `npx email-agent-mcp` aus, um den MCP-Server zu starten, und konfigurieren Sie ihn dann in Ihren Claude Code-Einstellungen.

### Koennen Agenten ohne meine Erlaubnis E-Mails senden?

Nein. Die Sende-Zulassungsliste ist standardmaessig leer. Agenten koennen keine E-Mails senden, bis Sie explizit erlaubte Empfaenger konfigurieren.

### Speichert dieses Projekt meine E-Mail-Zugangsdaten?

OAuth-Tokens werden von MSAL (Microsoft) verwaltet und in Ihrem Betriebssystem-Schluesselbund oder in lokalen Konfigurationsdateien unter `~/.email-agent-mcp/` gespeichert. Agent Email speichert niemals Klartext-Passwoerter.

### Kann ich mehrere Postfaecher verbinden?

Ja. Sie koennen Microsoft 365 und Gmail gleichzeitig konfigurieren. Leseaktionen verwenden standardmaessig Ihr primaeres Postfach; Schreibaktionen erfordern die Angabe eines Postfachs, wenn mehrere konfiguriert sind.

## Siehe auch

- [Safe DOCX Suite](https://github.com/UseJunior/safe-docx) -- chirurgische Bearbeitung von Word-Dokumenten mit Coding-Agenten
- [Open Agreements](https://github.com/open-agreements/open-agreements) -- rechtliche Standardvorlagen mit Coding-Agenten ausfuellen

## Datenschutz

Agent Email laeuft vollstaendig auf Ihrem lokalen Rechner. E-Mail-Zugangsdaten werden im Schluesselbund Ihres Betriebssystems (MSAL) und in lokalen Konfigurationsdateien gespeichert. Agent Email selbst sendet keine E-Mail-Inhalte an externe Server.

## Governance

- [Beitragsleitfaden](https://github.com/UseJunior/email-agent-mcp/blob/main/CONTRIBUTING.md) (Englisch)
- [Verhaltenskodex](https://github.com/UseJunior/email-agent-mcp/blob/main/CODE_OF_CONDUCT.md) (Englisch)
- [Sicherheitsrichtlinie](https://github.com/UseJunior/email-agent-mcp/blob/main/SECURITY.md) (Englisch)
- [Aenderungsprotokoll](https://github.com/UseJunior/email-agent-mcp/blob/main/CHANGELOG.md) (Englisch)
