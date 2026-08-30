#!/usr/bin/env bash
set -euo pipefail

: "${TUNNEL_URL:?Set TUNNEL_URL to the public API URL.}"
: "${API_TOKEN:?Set API_TOKEN to the API bearer token.}"

BASE_URL="${TUNNEL_URL%/}"
TEST_QUERY="${TEST_QUERY:-add a mobileNotes field to Post}"

api_get() {
  curl --silent --show-error --fail-with-body \
    --header "Authorization: Bearer ${API_TOKEN}" \
    --header "ngrok-skip-browser-warning: true" \
    "$1"
}

api_post() {
  curl --silent --show-error --fail-with-body \
    --request POST \
    --header "Authorization: Bearer ${API_TOKEN}" \
    --header "ngrok-skip-browser-warning: true" \
    --header "Content-Type: application/json" \
    --data "$2" \
    "$1"
}

graph_ready() {
  node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).graphReady === true))' "$1"
}

echo "GET /api/status"
status="$(api_get "${BASE_URL}/api/status")"
printf '%s\n' "$status"

if [[ "$(graph_ready "$status")" != "true" ]]; then
  echo "POST /api/init"
  init_response="$(api_post "${BASE_URL}/api/init" '{}')"
  printf '%s\n' "$init_response"

  for attempt in {1..30}; do
    sleep 2
    status="$(api_get "${BASE_URL}/api/status")"
    echo "GET /api/status (poll ${attempt})"
    printf '%s\n' "$status"
    if [[ "$(graph_ready "$status")" == "true" ]]; then
      break
    fi
  done

  if [[ "$(graph_ready "$status")" != "true" ]]; then
    echo "Graph did not become ready within 60 seconds." >&2
    exit 1
  fi
fi

payload="$(node -e 'console.log(JSON.stringify({ query: process.argv[1] }))' "$TEST_QUERY")"
echo "POST /api/query: ${TEST_QUERY}"
response="$(api_post "${BASE_URL}/api/query" "$payload")"
printf '%s\n' "$response"
