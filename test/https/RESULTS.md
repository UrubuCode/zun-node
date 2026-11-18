# Node.js v25 `https` test results

Oracle: `nodejs/node@v25.0.0` `test/parallel/test-https-*.js`, run by `tools/run_node_tests.sh --module https` (bundle + `zun run --ext`). **24 / 62 passing (38.7%)**; six files that run into the per-test timeout were not reached in this run and are counted as failing.

| Test | Result |
|---|---|
| `test-https-abortcontroller.js` | ❌ assertion |
| `test-https-agent-abort-controller.js` | ✅ pass |
| `test-https-agent-additional-options.js` | ❌ parse |
| `test-https-agent-constructor.js` | ❌ runtime |
| `test-https-agent-create-connection.js` | ❌ parse |
| `test-https-agent-disable-session-reuse.js` | ✅ pass |
| `test-https-agent-getname.js` | ✅ pass |
| `test-https-agent-keylog.js` | ❌ parse |
| `test-https-agent-servername.js` | ✅ pass |
| `test-https-agent-session-eviction.js` | ❌ runtime |
| `test-https-agent-session-injection.js` | ✅ pass |
| `test-https-agent-session-reuse.js` | ✅ pass |
| `test-https-agent-sni.js` | ❌ assertion |
| `test-https-agent-sockets-leak.js` | ✅ pass |
| `test-https-agent-unref-socket.js` | ❌ runtime |
| `test-https-agent.js` | ✅ pass |
| `test-https-argument-of-creating.js` | ❌ runtime |
| `test-https-autoselectfamily.js` | ❌ parse |
| `test-https-byteswritten.js` | ❌ assertion |
| `test-https-client-checkServerIdentity.js` | ❌ runtime |
| `test-https-client-get-url.js` | ✅ pass |
| `test-https-client-override-global-agent.js` | ✅ pass |
| `test-https-client-reject.js` | ❌ parse |
| `test-https-client-renegotiation-limit.js` | ❌ runtime |
| `test-https-client-resume.js` | ❌ parse |
| `test-https-close.js` | ✅ pass |
| `test-https-connect-address-family.js` | ✅ pass |
| `test-https-connecting-to-http.js` | ✅ pass |
| `test-https-drain.js` | ❌ timeout |
| `test-https-eof-for-eom.js` | ✅ pass |
| `test-https-foafssl.js` | ✅ pass |
| `test-https-host-headers.js` | ❌ parse |
| `test-https-hwm.js` | ❌ assertion |
| `test-https-insecure-parse-per-stream.js` | ❌ assertion |
| `test-https-keep-alive-drop-requests.js` | ❌ parse |
| `test-https-localaddress-bind-error.js` | ✅ pass |
| `test-https-localaddress.js` | ❌ bundle failed |
| `test-https-max-header-size-per-stream.js` | ❌ parse |
| `test-https-max-headers-count.js` | ✅ pass |
| `test-https-options-boolean-check.js` | ❌ assertion |
| `test-https-pfx.js` | ❌ parse |
| `test-https-request-arguments.js` | ✅ pass |
| `test-https-resume-after-renew.js` | ❌ runtime |
| `test-https-selfsigned-no-keycertsign-no-crash.js` | ❌ runtime |
| `test-https-server-async-dispose.js` | ❌ parse |
| `test-https-server-close-all.js` | ✅ pass |
| `test-https-server-close-destroy-timeout.js` | ✅ pass |
| `test-https-server-close-idle.js` | ✅ pass |
| `test-https-server-connections-checking-leak.js` | ❌ bundle failed |
| `test-https-server-headers-timeout.js` | ✅ pass |
| `test-https-server-options-incoming-message.js` | ❌ runtime |
| `test-https-server-options-server-response.js` | ❌ runtime |
| `test-https-server-request-timeout.js` | ✅ pass |
| `test-https-set-timeout-server.js` | ❌ timeout |
| `test-https-simple.js` | ❌ parse |
| `test-https-socket-options.js` | ✅ pass |
| `test-https-strict.js` | ❌ timeout |
| `test-https-timeout-server-2.js` | ❌ timeout |
| `test-https-timeout-server.js` | ❌ timeout |
| `test-https-timeout.js` | ❌ timeout |
| `test-https-truncate.js` | ❌ timeout |
| `test-https-unix-socket-self-signed.js` | ❌ timeout |
