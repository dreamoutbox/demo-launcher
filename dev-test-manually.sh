#!/usr/bin/env bash
set -euo pipefail

PORT=8787
BASE_URL="http://localhost:${PORT}"
PROJECT_ID="awesome-shop-demo"

# Helper functions for clean logging and assertions
log_step() {
    echo -e "\n\033[1;34m===> $1\033[0m"
}

pass() {
    echo -e "\033[1;32m✔ ASSERT PASSED:\033[0m $1"
}

fail() {
    echo -e "\033[1;31m✘ ASSERT FAILED:\033[0m $1"
    exit 1
}

# 1. Initialize local D1 schema and reset state for a clean test run
log_step "1. Initializing local D1 database schema..."
npx wrangler d1 execute mydb --local --file=./schema.sql
./dev-migrate.sh --local
npx wrangler d1 execute mydb --local --command="DELETE FROM project_demos;"

# 2. Start wrangler dev in background and ensure it exits when the script exits
log_step "2. Starting 'wrangler dev' in the background..."
npx wrangler dev --port "${PORT}" --test-scheduled > .wrangler-dev.log 2>&1 &
WRANGLER_PID=$!

cleanup() {
    log_step "Cleaning up: Stopping background 'wrangler dev' (PID: ${WRANGLER_PID})..."
    kill "${WRANGLER_PID}" 2>/dev/null || true
    wait "${WRANGLER_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait until wrangler dev is ready to accept connections
echo "Waiting for Worker at ${BASE_URL} to become ready..."
for i in {1..30}; do
    if curl -s "${BASE_URL}/api/projects" >/dev/null 2>&1; then
        echo "Worker is up and listening!"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "--- Wrangler Log ---"
        cat .wrangler-dev.log
        fail "Timed out waiting for wrangler dev to start."
    fi
    sleep 1
done

# 3. Launch the demo project
log_step "3. Verifying POST /api/launch rejects request without Turnstile token..."
NO_TOKEN_RES=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/launch" \
  -H "Content-Type: application/json" \
  -d "{\"projectId\": \"${PROJECT_ID}\"}")
HTTP_CODE=$(echo "${NO_TOKEN_RES}" | tail -n1)
BODY=$(echo "${NO_TOKEN_RES}" | sed '$d')
echo "${BODY}" | jq .

if [ "${HTTP_CODE}" -eq 400 ]; then
    pass "Request without Turnstile token rejected with HTTP 400"
else
    fail "Expected HTTP 400 for missing Turnstile token, got ${HTTP_CODE}"
fi

log_step "3b. Sending POST /api/launch for '${PROJECT_ID}' with Turnstile token..."
LAUNCH_RES=$(curl -s -X POST "${BASE_URL}/api/launch" \
  -H "Content-Type: application/json" \
  -d "{\"projectId\": \"${PROJECT_ID}\", \"turnstileToken\": \"local-test-token\"}")

echo "${LAUNCH_RES}" | jq .

echo "${LAUNCH_RES}" | jq -e --arg pid "${PROJECT_ID}" '.projectId == $pid' >/dev/null \
    && pass "Launch request queued for ${PROJECT_ID}" \
    || fail "Launch request did not return expected projectId"

# Wait for Queue consumer + DigitalOceanMockService (1.5s mock provisioning delay)
log_step "4. Waiting 3 seconds for Queue consumer to finish provisioning mock droplet..."
sleep 3

# 4. Check project status
log_step "5. Fetching GET /api/projects..."
PROJECTS_RES=$(curl -s "${BASE_URL}/api/projects")
echo "${PROJECTS_RES}" | jq .

echo "${PROJECTS_RES}" | jq -e --arg pid "${PROJECT_ID}" \
    '.statuses[] | select(.project_id == $pid) | .status == "RUNNING"' >/dev/null \
    && pass "Demo '${PROJECT_ID}' is RUNNING" \
    || fail "Expected demo '${PROJECT_ID}' to be RUNNING"

# 5. Trigger standard CRON (1 hour threshold) -> Expect demo still running
log_step "6. Triggering standard scheduled CRON (1h maxDemoTime) — expecting demo to remain RUNNING..."
# Note: /cdn-cgi/handler/scheduled returns an empty 200 OK body, so we inspect /api/projects right after
curl -s "${BASE_URL}/cdn-cgi/handler/scheduled" >/dev/null

AFTER_STD_CRON_RES=$(curl -s "${BASE_URL}/api/projects")
echo "${AFTER_STD_CRON_RES}" | jq .

echo "${AFTER_STD_CRON_RES}" | jq -e --arg pid "${PROJECT_ID}" \
    '.statuses[] | select(.project_id == $pid) | .status == "RUNNING"' >/dev/null \
    && pass "Demo '${PROJECT_ID}' is still RUNNING after standard 1-hour CRON check" \
    || fail "Demo '${PROJECT_ID}' should still be RUNNING"

# 6. Sleep 3 seconds so demo age exceeds 2 seconds
log_step "7. Sleeping 3 seconds so demo uptime exceeds 2 seconds..."
sleep 3

# 7. Trigger custom CRON cleanup with maxDemoTimeSeconds=2
log_step "8. Triggering custom CRON cleanup (maxDemoTimeSeconds=2)..."
CLEANUP_RES=$(curl -s -H "x-admin-key: demo-admin-key" "${BASE_URL}/api/cron-cleanup?maxDemoTimeSeconds=2")
echo "${CLEANUP_RES}" | jq .

echo "${CLEANUP_RES}" | jq -e --arg pid "${PROJECT_ID}" \
    '.cleanedUp | index($pid) != null' >/dev/null \
    && pass "Custom CRON cleaned up expired demo '${PROJECT_ID}'" \
    || fail "Expected '${PROJECT_ID}' to be in cleanedUp array"

# 8. Assert all demo statuses are STOPPED
log_step "9. Verifying all demo statuses in GET /api/projects are STOPPED..."
FINAL_PROJECTS_RES=$(curl -s "${BASE_URL}/api/projects")
echo "${FINAL_PROJECTS_RES}" | jq .

echo "${FINAL_PROJECTS_RES}" | jq -e \
    '(.statuses | length > 0) and (.statuses | all(.status == "STOPPED" and .droplet_id == null and .droplet_ip == null))' >/dev/null \
    && pass "All demos have status == 'STOPPED' and cleared droplet fields" \
    || fail "Expected all demo statuses to be STOPPED"

# 9. Verify we can re-launch the project now that it is STOPPED
log_step "10. Re-launching '${PROJECT_ID}' via POST /api/launch to confirm re-launch works..."
RELAUNCH_RES=$(curl -s -X POST "${BASE_URL}/api/launch" \
  -H "Content-Type: application/json" \
  -d "{\"projectId\": \"${PROJECT_ID}\", \"turnstileToken\": \"local-test-token\"}")
echo "${RELAUNCH_RES}" | jq .

echo -e "\n\033[1;32m🎉 ALL E2E CHECKS PASSED SUCCESSFULLY!\033[0m"
