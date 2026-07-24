#!/bin/zsh

set -euo pipefail

function usage {
  cat >&2 <<'EOF'
Configure the production Google OAuth credentials for the email-agent-mcp broker.

Usage:
  ./scripts/configure-production-secrets.zsh [--azure-vault VAULT_NAME]

The script always writes the credentials to the linked Vercel project's
Production environment. When --azure-vault is supplied, it also stores a
central copy in that Azure Key Vault.

Credential values are read interactively, are not echoed, and are never
included in a command-line argument.
EOF
}

azure_vault_name=''

while (( $# > 0 )); do
  case "$1" in
    --azure-vault)
      if (( $# < 2 )) || [[ -z "$2" ]]; then
        print -u2 'ERROR: --azure-vault requires a vault name.'
        usage
        exit 2
      fi
      azure_vault_name="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      print -u2 "ERROR: unknown argument: $1"
      usage
      exit 2
      ;;
  esac
done

if ! command -v vercel >/dev/null 2>&1; then
  print -u2 'ERROR: required command not found: vercel'
  exit 1
fi
if [[ -n "$azure_vault_name" ]] && ! command -v az >/dev/null 2>&1; then
  print -u2 'ERROR: required command not found: az'
  exit 1
fi

script_directory="${0:A:h}"
broker_directory="${script_directory:h}"

if [[ ! -f "$broker_directory/.vercel/project.json" ]]; then
  print -u2 "ERROR: $broker_directory is not linked to a Vercel project."
  print -u2 'Run vercel link from apps/oauth-broker first.'
  exit 1
fi

IFS= read -r "oauth_client_id?Google OAuth client ID: "
if [[ -z "$oauth_client_id" ]]; then
  print -u2 'ERROR: client ID cannot be empty.'
  exit 1
fi

IFS= read -r -s "oauth_client_secret?Google OAuth client secret: "
print
if [[ -z "$oauth_client_secret" ]]; then
  print -u2 'ERROR: client secret cannot be empty.'
  exit 1
fi

credential_directory=''
function cleanup {
  oauth_client_id=''
  oauth_client_secret=''
  if [[ -n "$credential_directory" && -d "$credential_directory" ]]; then
    rm -f \
      "$credential_directory/client-id" \
      "$credential_directory/client-secret"
    rmdir "$credential_directory"
  fi
}
trap cleanup EXIT

if [[ -n "$azure_vault_name" ]]; then
  credential_directory="$(mktemp -d /tmp/email-agent-oauth.XXXXXX)"
  chmod 700 "$credential_directory"
  printf '%s' "$oauth_client_id" > "$credential_directory/client-id"
  printf '%s' "$oauth_client_secret" > "$credential_directory/client-secret"

  az keyvault secret set \
    --vault-name "$azure_vault_name" \
    --name email-agent-mcp-gmail-oauth-client-id \
    --file "$credential_directory/client-id" \
    --encoding utf-8 \
    --content-type text/plain \
    --only-show-errors \
    --output none

  az keyvault secret set \
    --vault-name "$azure_vault_name" \
    --name email-agent-mcp-gmail-oauth-client-secret \
    --file "$credential_directory/client-secret" \
    --encoding utf-8 \
    --content-type text/plain \
    --only-show-errors \
    --output none

  print -u2 "Stored central copies in Azure Key Vault: $azure_vault_name"
fi

printf '%s' "$oauth_client_id" |
  vercel env add GMAIL_OAUTH_CLIENT_ID production \
    --force \
    --yes \
    --sensitive \
    --scope use-junior \
    --cwd "$broker_directory"

printf '%s' "$oauth_client_secret" |
  vercel env add GMAIL_OAUTH_CLIENT_SECRET production \
    --force \
    --yes \
    --sensitive \
    --scope use-junior \
    --cwd "$broker_directory"

print -u2 'Stored Google OAuth credentials in the broker Production environment.'
