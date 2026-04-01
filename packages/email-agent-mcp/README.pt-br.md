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

> **Nota de traducao:** O `README.md` em ingles e a fonte canonica de verdade. Esta traducao pode ter pequeno atraso. Atualizacoes importantes do README em ingles devem ser propagadas em ate 72 horas.

**email-agent-mcp** por [UseJunior](https://usejunior.com) -- conectividade de e-mail para agentes de IA.

Agent Email e um servidor MCP de codigo aberto em TypeScript que oferece aos agentes de IA acesso seguro a e-mail. Ele expoe operacoes de e-mail via [Model Context Protocol](https://modelcontextprotocol.io/) para qualquer runtime de agente compativel com MCP -- Claude Code, Gemini CLI, Cursor, Goose, entre outros. As configuracoes padrao priorizam seguranca, o que significa que agentes nao podem enviar e-mails ate que voce configure explicitamente uma lista de permitidos.

## Por Que Este Projeto Existe

Agentes de IA precisam ler, responder e agir sobre e-mails, mas as APIs de e-mail sao complexas. Fluxos OAuth, consultas delta do Graph, push subscriptions do Gmail, conversao de HTML para markdown, semantica de threads -- cada provedor tem suas particularidades.

O Agent Email encapsula toda essa complexidade em ferramentas MCP deterministicas com barreiras de seguranca:

- listas de permitidos para envio e recebimento que controlam com quem os agentes podem se comunicar
- exclusao desabilitada por padrao (requer ativacao explicita)
- sanitizacao de erros que remove chaves de API, caminhos de arquivos e stack traces
- sandboxing de arquivos de corpo com protecao contra travessia de diretorio

## Uso com Claude Code

Adicione ao `~/.claude/settings.json` ou ao `settings.json` do seu projeto em `.claude/settings.json`:

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

## Uso com Gemini CLI

```bash
gemini extensions install https://github.com/UseJunior/email-agent-mcp
```

## Uso com Cursor

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

## Uso via CLI

```bash
npx -y email-agent-mcp
```

O assistente interativo de configuracao guia voce pelo processo de configuracao OAuth e selecao de caixa de correio.

## Referencia de Ferramentas

O Agent Email expoe 15 ferramentas MCP:

| Ferramenta | Descricao | Tipo |
|------------|-----------|------|
| `list_emails` | Lista e-mails recentes com filtragem | leitura |
| `read_email` | Le o conteudo completo de um e-mail como markdown | leitura |
| `search_emails` | Busca textual completa nas caixas de correio | leitura |
| `get_mailbox_status` | Status da conexao e avisos | leitura |
| `get_thread` | Contexto completo da conversa | leitura |
| `send_email` | Envia novo e-mail (controlado por lista de permitidos) | escrita |
| `reply_to_email` | Responde com threading RFC | escrita |
| `create_draft` | Cria rascunho de e-mail | escrita |
| `update_draft` | Atualiza conteudo de rascunho | escrita |
| `send_draft` | Envia um rascunho salvo | escrita |
| `label_email` | Aplica marcadores/categorias | escrita |
| `flag_email` | Marca/desmarca e-mails com sinalizacao | escrita |
| `mark_read` | Marca como lido/nao lido | escrita |
| `move_to_folder` | Move entre pastas | escrita |
| `delete_email` | Exclui (requer ativacao explicita) | destrutivo |

## Suporte a Provedores

| Provedor | Status | Pacote |
|----------|--------|--------|
| Microsoft 365 (Graph API) | Totalmente suportado | `@usejunior/provider-microsoft` |
| Gmail | Em breve | `@usejunior/provider-gmail` |

O pacote do provedor Gmail ja existe com cobertura completa de testes. A integracao com o servidor MCP esta em andamento.

## Configuracoes Padrao de Seguranca

O Agent Email vem com configuracoes restritivas por padrao que voce pode flexibilizar conforme necessario:

- **Lista de permitidos para envio**: vazia por padrao -- agentes nao podem enviar e-mails ate que voce adicione destinatarios
- **Lista de permitidos para recebimento**: aceita todos por padrao -- controla quais remetentes acionam o watcher
- **Exclusao desabilitada**: agentes nao podem excluir e-mails a menos que voce defina `user_explicitly_requested_deletion: true`
- **Sanitizacao de erros**: chaves de API, caminhos de arquivos e stack traces sao removidos das respostas de erro
- **Sandboxing de arquivos de corpo**: sem travessia `../`, sem symlinks, deteccao de binarios

## Perguntas Frequentes

### Funciona com o Claude Code?

Sim. Execute `npx email-agent-mcp` para iniciar o servidor MCP e depois configure-o nas configuracoes do seu Claude Code.

### Agentes podem enviar e-mail sem minha permissao?

Nao. A lista de permitidos para envio e vazia por padrao. Agentes nao podem enviar nenhum e-mail ate que voce configure explicitamente os destinatarios permitidos.

### O Agent Email armazena minhas credenciais de e-mail?

Os tokens OAuth sao gerenciados pelo MSAL (Microsoft) e armazenados no keychain do seu sistema operacional ou em arquivos de configuracao locais em `~/.email-agent-mcp/`. O Agent Email nunca armazena senhas em texto puro.

### Posso conectar multiplas caixas de correio?

Sim. Voce pode configurar Microsoft 365 e Gmail simultaneamente. Acoes de leitura usam sua caixa de correio principal por padrao; acoes de escrita exigem a especificacao de uma caixa de correio quando multiplas estao configuradas.

## Veja Tambem

- [Safe DOCX Suite](https://github.com/UseJunior/safe-docx) -- edicao cirurgica de documentos Word com agentes de codigo
- [Open Agreements](https://github.com/open-agreements/open-agreements) -- preenchimento de modelos juridicos padrao com agentes de codigo

## Privacidade

O Agent Email roda inteiramente na sua maquina local. As credenciais de e-mail sao armazenadas no keychain do seu sistema operacional (MSAL) e em arquivos de configuracao locais. Nenhum conteudo de e-mail e enviado para servidores externos pelo Agent Email.

## Governanca

- [Guia de Contribuicao](https://github.com/UseJunior/email-agent-mcp/blob/main/CONTRIBUTING.md) (em ingles)
- [Codigo de Conduta](https://github.com/UseJunior/email-agent-mcp/blob/main/CODE_OF_CONDUCT.md) (em ingles)
- [Politica de Seguranca](https://github.com/UseJunior/email-agent-mcp/blob/main/SECURITY.md) (em ingles)
- [Changelog](https://github.com/UseJunior/email-agent-mcp/blob/main/CHANGELOG.md)
