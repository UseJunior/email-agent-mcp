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

> **Nota de traduccion:** El README.md en ingles es la fuente canonica. Esta traduccion puede tener un pequeno retraso respecto a las actualizaciones. Los cambios importantes deben propagarse en un plazo de 72 horas.

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
      "args": ["-y", "email-agent-mcp"]
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
      "args": ["-y", "email-agent-mcp"]
    }
  }
}
```

## Uso con CLI

```bash
npx -y email-agent-mcp
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
| Gmail | Compatible mediante OAuth interactivo por CLI o configuracion manual de refresh token | `@usejunior/provider-gmail` |

Usa `email-agent-mcp configure --provider gmail` para ejecutar el flujo OAuth local en el navegador, o agrega un archivo manual en `~/.email-agent-mcp/tokens/`. Consulta `packages/provider-gmail/README.md`.

## Seguridad por defecto

Agent Email se distribuye con valores por defecto restrictivos que puedes flexibilizar segun sea necesario:

- **Lista de permitidos de envio**: vacia por defecto -- los agentes no pueden enviar correo hasta que agregues destinatarios
- **Lista de permitidos de recepcion**: acepta todo por defecto -- controla que remitentes activan el observador
- **Eliminacion deshabilitada**: los agentes no pueden eliminar correo a menos que establezcas `user_explicitly_requested_deletion: true`
- **Sanitizacion de errores**: las claves de API, rutas de archivos y trazas de pila se eliminan de las respuestas de error
- **Sandboxing de archivos de cuerpo**: sin recorrido `../`, sin enlaces simbolicos, deteccion de binarios

## Preguntas frecuentes

### Funciona con Claude Code?

Si. Ejecuta `npx email-agent-mcp` para iniciar el servidor MCP y luego configuralo en los ajustes de Claude Code.

### Pueden los agentes enviar correo sin mi permiso?

No. La lista de permitidos de envio esta vacia por defecto. Los agentes no pueden enviar ningun correo hasta que configures explicitamente los destinatarios permitidos.

### Se almacenan mis credenciales de correo?

Los tokens OAuth son gestionados por MSAL (Microsoft) y se almacenan en el llavero de tu sistema operativo o en archivos de configuracion locales en `~/.email-agent-mcp/`. Agent Email nunca almacena contrasenas en texto plano.

### Puedo conectar multiples buzones?

Si. Puedes configurar Microsoft 365 y Gmail simultaneamente. Las acciones de lectura usan tu buzon principal por defecto; las acciones de escritura requieren especificar un buzon cuando hay multiples configurados.

## Vease tambien

- [Safe DOCX Suite](https://github.com/UseJunior/safe-docx) -- edicion quirurgica de documentos Word con agentes de codigo
- [Open Agreements](https://github.com/open-agreements/open-agreements) -- completar plantillas legales estandar con agentes de codigo

## Privacidad

Agent Email se ejecuta completamente en tu maquina local. Las credenciales de correo se almacenan en el llavero de tu sistema operativo (MSAL) y en archivos de configuracion locales. Agent Email no envia contenido de correo a servidores externos.

## Gobernanza

- [Guia de contribucion](https://github.com/UseJunior/email-agent-mcp/blob/main/CONTRIBUTING.md) (en ingles)
- [Codigo de conducta](https://github.com/UseJunior/email-agent-mcp/blob/main/CODE_OF_CONDUCT.md) (en ingles)
- [Politica de seguridad](https://github.com/UseJunior/email-agent-mcp/blob/main/SECURITY.md) (en ingles)
- [Registro de cambios](https://github.com/UseJunior/email-agent-mcp/blob/main/CHANGELOG.md) (en ingles)
