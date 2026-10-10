#!/bin/sh
# A fake gh for tests and manual runs: prints invented data, never touches the network or a real account.
case "$1 $2" in
  "api user") echo "demo-user" ;;
  "repo list")
    printf '[{"name":"demo-app","description":"Synthetic","primaryLanguage":{"name":"TypeScript"},"stargazerCount":3,"pushedAt":"2026-10-07T10:00:00Z","url":"https://github.com/demo-user/demo-app","isPrivate":false,"isFork":false,"isArchived":false,"issues":{"totalCount":2},"pullRequests":{"totalCount":5}}]\n' ;;
  "run list") echo '[{"status":"completed","conclusion":"failure"}]' ;;
  *) echo "fake gh: unsupported" >&2; exit 1 ;;
esac
