# Agent Email

[![npm version](https://img.shields.io/npm/v/@usejunior/email-agent-mcp)](https://www.npmjs.com/package/@usejunior/email-agent-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@usejunior/email-agent-mcp.svg)](https://npmjs.org/package/@usejunior/email-agent-mcp)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/UseJunior/email-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/UseJunior/email-agent-mcp/actions/workflows/ci.yml)
[![codecov](https://img.shields.io/codecov/c/github/UseJunior/email-agent-mcp/main)](https://app.codecov.io/gh/UseJunior/email-agent-mcp)
[![GitHub stargazers](https://img.shields.io/github/stars/UseJunior/email-agent-mcp?style=social)](https://github.com/UseJunior/email-agent-mcp/stargazers)
[![Tests: Vitest](https://img.shields.io/badge/tests-vitest-6E9F18)](https://vitest.dev/)
[![OpenSpec Traceability](https://img.shields.io/badge/openspec-traceability%20gate-brightgreen)](./scripts/check-spec-coverage.mjs)
[![Socket Badge](https://socket.dev/api/badge/npm/package/@usejunior/email-agent-mcp)](https://socket.dev/npm/package/@usejunior/email-agent-mcp)
[![install size](https://packagephobia.com/badge?p=@usejunior/email-agent-mcp)](https://packagephobia.com/result?p=@usejunior/email-agent-mcp)

[English](./README.md) | [Español](./README.es.md) | [简体中文](./README.zh.md) | [Português (Brasil)](./README.pt-br.md) | [Deutsch](./README.de.md)

> **Nota de traduccion:** El README.md en ingles es la fuente canonica. Esta traduccion puede tener un pequeno retraso respecto a las actualizaciones.

**email-agent-mcp** de [UseJunior](https://usejunior.com) -- conectividad de correo electronico para agentes de IA.

Agent Email es un servidor MCP de codigo abierto escrito en TypeScript que brinda a los agentes de IA acceso seguro al correo electronico. Expone operaciones de correo a traves del [Model Context Protocol](https://modelcontextprotocol.io/) para cualquier entorno de ejecucion compatible con MCP -- Claude Code, Gemini CLI, Cursor, Goose, y mas. La configuracion de seguridad por defecto impide que los agentes envien correo hasta que configures explicitamente una lista de permitidos.

## Por que existe este proyecto

Los agentes de IA necesitan leer, responder y actuar sobre el correo electronico, pero las APIs de correo son complejas. Flujos OAuth, consultas delta de Graph, suscripciones push de Gmail, conversion de HTML a markdown, semantica de hilos -- cada proveedor tiene sus propias particularidades.

Agent Email encapsula esta complejidad en herramientas MCP deterministas con medidas de seguridad:

- listas de permitidos de envio y recepcion que controlan con quien pueden comunicarse los agentes
- eliminacion deshabilitada por defecto (requiere activacion explicita)
- sanitizacion de errores que elimina claves de API, rutas de archivos y trazas de pila
- sandboxing de archivos de cuerpo con proteccion contra recorrido de rutas (path traversal)

## Uso con Claude Code

Agrega lo siguiente a `~/.claude/settings.json` o al archivo `.claude/settings.json` de tu proyecto:

```json
{
  "mcpServers": {
    "email-agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@usejunior/email-agent-mcp"]
    }
  }
}
```

## Uso con Gemini CLI

```bash
gemini extensions install https://github.com/UseJunior/email-agent-mcp
```

## Uso con Cursor

```json
// .cursor/mcp.json
{
  "mcpServers": {
    "email-agent-mcp": {
      "command": "npx",
      "args": ["-y", "@usejunior/email-agent-mcp"]
    }
  }
}
```

## Uso con CLI

```bash
npx -y @usejunior/email-agent-mcp
```

El asistente de configuracion interactivo te guiara a traves de la configuracion de OAuth y la seleccion de buzon.

## Referencia de herramientas

Agent Email expone 15 herramientas MCP:

| Herramienta | Descripcion | Tipo |
|-------------|-------------|------|
| `list_emails` | Listar correos recientes con filtrado | lectura |
| `read_email` | Leer el contenido completo de un correo como markdown | lectura |
| `search_emails` | Busqueda de texto completo en buzones | lectura |
| `get_mailbox_status` | Estado de conexion y advertencias | lectura |
| `get_thread` | Contexto completo de la conversacion | lectura |
| `send_email` | Enviar correo nuevo (controlado por lista de permitidos) | escritura |
| `reply_to_email` | Responder con hilos RFC | escritura |
| `create_draft` | Crear borrador de correo | escritura |
| `update_draft` | Actualizar contenido del borrador | escritura |
| `send_draft` | Enviar un borrador guardado | escritura |
| `label_email` | Aplicar etiquetas/categorias | escritura |
| `flag_email` | Marcar/desmarcar correos como destacados | escritura |
| `mark_read` | Marcar como leido/no leido | escritura |
| `move_to_folder` | Mover entre carpetas | escritura |
| `delete_email` | Eliminar (requiere activacion explicita) | destructivo |

## Soporte de proveedores

| Proveedor | Estado | Paquete |
|-----------|--------|---------|
| Microsoft 365 (Graph API) | Totalmente soportado | `@usejunior/provider-microsoft` |
| Gmail | Proximamente | `@usejunior/provider-gmail` |

El paquete del proveedor de Gmail existe con cobertura completa de pruebas. La integracion con el servidor MCP esta en progreso.

## Seguridad por defecto

Agent Email se distribuye con valores por defecto restrictivos que puedes flexibilizar segun sea necesario:

- **Lista de permitidos de envio**: vacia por defecto -- los agentes no pueden enviar correo hasta que agregues destinatarios
- **Lista de permitidos de recepcion**: acepta todo por defecto -- controla que remitentes activan el observador
- **Eliminacion deshabilitada**: los agentes no pueden eliminar correo a menos que establezcas `user_explicitly_requested_deletion: true`
- **Sanitizacion de errores**: las claves de API, rutas de archivos y trazas de pila se eliminan de las respuestas de error
- **Sandboxing de archivos de cuerpo**: sin recorrido `../`, sin enlaces simbolicos, deteccion de binarios

## Paquetes

| Paquete | Descripcion |
|---------|-------------|
| `@usejunior/email-core` | Acciones principales de correo, motor de contenido, seguridad e interfaces de proveedores |
| `@usejunior/email-mcp` | Adaptador de servidor MCP, CLI y observador |
| `@usejunior/provider-microsoft` | Proveedor de correo con Microsoft Graph API |
| `@usejunior/provider-gmail` | Proveedor de correo con Gmail API |
| `@usejunior/email-agent-mcp` | Empaquetado de distribucion (`npx @usejunior/email-agent-mcp`) |

## Senales de calidad y confianza

- CI se ejecuta en cada pull request y push a main (lint, verificacion de tipos, pruebas en Node 20 + 22)
- Escaneo de seguridad con CodeQL y Semgrep
- Cobertura publicada en Codecov
- Cumplimiento de trazabilidad OpenSpec via `npm run check:spec-coverage`
- 310 pruebas en 34 archivos de pruebas
- Mantenedor: [Steven Obiajulu](https://www.linkedin.com/in/steven-obiajulu/)

## Arquitectura

```
email-agent-mcp/
├── packages/
│   ├── email-core          Acciones principales, motor de contenido, seguridad
│   ├── email-mcp           Adaptador de servidor MCP, CLI, observador
│   ├── provider-microsoft  Proveedor de Microsoft Graph
│   ├── provider-gmail      Proveedor de Gmail API
│   └── email-agent-mcp         Empaquetado de distribucion (punto de entrada npx)
├── openspec/               Desarrollo guiado por especificaciones
└── scripts/                Scripts de CI y validacion
```

## Publicacion de versiones

Publicacion basada en etiquetas (tags) via GitHub Actions con publicacion confiable OIDC de npm. Los 5 paquetes se publican en orden de dependencia con `--provenance`.

## Preguntas frecuentes

### Funciona con Claude Code?

Si. Ejecuta `npx @usejunior/email-agent-mcp` para iniciar el servidor MCP y luego configuralo en los ajustes de Claude Code.

### Pueden los agentes enviar correo sin mi permiso?

No. La lista de permitidos de envio esta vacia por defecto. Los agentes no pueden enviar ningun correo hasta que configures explicitamente los destinatarios permitidos.

### Se almacenan mis credenciales de correo?

Los tokens OAuth son gestionados por MSAL (Microsoft) y se almacenan en el llavero de tu sistema operativo o en archivos de configuracion locales en `~/.email-agent-mcp/`. Agent Email nunca almacena contrasenas en texto plano.

### Puedo conectar multiples buzones?

Si. Puedes configurar Microsoft 365 y Gmail simultaneamente. Las acciones de lectura usan tu buzon principal por defecto; las acciones de escritura requieren especificar un buzon cuando hay multiples configurados.

## Desarrollo

Consulta las instrucciones de desarrollo en el [README principal en ingles](./README.md#development).

```bash
npm ci
npm run build
npm run lint --workspaces --if-present
npm run test:run
npm run check:spec-coverage
```

## Vease tambien

- [Safe DOCX Suite](https://github.com/UseJunior/safe-docx) -- edicion quirurgica de documentos Word con agentes de codigo
- [Open Agreements](https://github.com/open-agreements/open-agreements) -- completar plantillas legales estandar con agentes de codigo

## Privacidad

Agent Email se ejecuta completamente en tu maquina local. Las credenciales de correo se almacenan en el llavero de tu sistema operativo (MSAL) y en archivos de configuracion locales. Agent Email no envia contenido de correo a servidores externos.

## Gobernanza

- [Guia de contribucion](CONTRIBUTING.md) (en ingles)
- [Codigo de conducta](CODE_OF_CONDUCT.md) (en ingles)
- [Politica de seguridad](SECURITY.md) (en ingles)
- [Registro de cambios](CHANGELOG.md) (en ingles)
