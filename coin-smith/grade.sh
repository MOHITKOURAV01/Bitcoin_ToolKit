#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# grade.sh — Coin Smith PSBT Builder Grader (Week 2)
#
# Validates cli.sh output against all public fixtures.
# Dependencies: bash, jq, base64
###############################################################################

# ── Constants & colors ───────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

FIXTURES_DIR="fixtures"
OUT_DIR="out"

TOTAL_FIXTURES=0
PASSED_FIXTURES=0
FAILED_FIXTURES=0

# ── Locate jq ────────────────────────────────────────────────────────────────

JQ=""
for candidate in jq /opt/homebrew/bin/jq /usr/local/bin/jq; do
  if command -v "$candidate" &>/dev/null; then
    JQ="$candidate"
    break
  fi
done
if [[ -z "$JQ" ]]; then
  echo "Error: jq is required but not found. Install it with: brew install jq" >&2
  exit 1
fi

# ── Detect base64 decode flag (macOS = -D, Linux = -d) ───────────────────────

B64_DECODE="-d"
if base64 -D </dev/null &>/dev/null 2>&1; then
  B64_DECODE="-D"
fi

# ── Utility functions ────────────────────────────────────────────────────────

# Per-fixture counters (set by caller, modified by pass/fail)
# fixture_pass and fixture_fail are managed in run_fixture

pass() {
  local msg="$1"
  printf "  ${GREEN}✓${RESET} %s\n" "$msg"
  ((fixture_pass++)) || true
}

fail() {
  local msg="$1"
  printf "  ${RED}✗${RESET} %s\n" "$msg"
  ((fixture_fail++)) || true
}

warn() {
  local msg="$1"
  printf "  ${YELLOW}!${RESET} %s\n" "$msg"
}

# ── Check functions ──────────────────────────────────────────────────────────

check_cli_exit() {
  local fixture_path="$1"
  if ./cli.sh "$fixture_path" >/dev/null 2>&1; then
    pass "cli.sh exits 0"
    return 0
  else
    fail "cli.sh exits non-zero"
    return 1
  fi
}

check_output_exists() {
  local output_path="$1"

  if [[ ! -f "$output_path" ]]; then
    fail "Output file missing: $output_path"
    return 1
  fi

  if ! $JQ empty "$output_path" 2>/dev/null; then
    fail "Output file is not valid JSON"
    return 1
  fi

  local ok
  ok=$($JQ -r '.ok // empty' "$output_path")
  if [[ "$ok" != "true" ]]; then
    fail "Output .ok is not true (got: ${ok:-null})"
    return 1
  fi

  pass "Output file exists and is valid JSON"
  return 0
}

check_required_fields() {
  local output_path="$1"

  local missing
  missing=$($JQ -r '
    ["ok","network","strategy","selected_inputs","outputs","change_index",
     "fee_sats","fee_rate_sat_vb","vbytes","rbf_signaling","locktime",
     "locktime_type","psbt_base64","warnings"] - keys | .[]
  ' "$output_path")

  if [[ -z "$missing" ]]; then
    pass "Required fields present"
    return 0
  else
    fail "Missing fields: $(echo "$missing" | tr '\n' ', ' | sed 's/,$//')"
    return 1
  fi
}

check_selected_inputs() {
  local output_path="$1"
  local fixture_path="$2"

  # Non-empty array
  local count
  count=$($JQ '.selected_inputs | length' "$output_path")
  if [[ "$count" -eq 0 ]]; then
    fail "selected_inputs is empty"
    return 1
  fi

  # Every selected input matches a fixture UTXO by txid+vout
  local invalid
  invalid=$($JQ --slurpfile fixture "$fixture_path" '
    [.selected_inputs[] |
      {txid, vout} as $sel |
      select(
        [$fixture[0].utxos[] | select(.txid == $sel.txid and .vout == $sel.vout)] | length == 0
      )
    ] | length
  ' "$output_path")

  if [[ "$invalid" -ne 0 ]]; then
    fail "selected_inputs contains $invalid input(s) not in fixture UTXOs"
    return 1
  fi

  # Respect policy.max_inputs
  local max_inputs
  max_inputs=$($JQ '.policy.max_inputs // empty' "$fixture_path")
  if [[ -n "$max_inputs" ]] && [[ "$count" -gt "$max_inputs" ]]; then
    fail "selected_inputs count ($count) exceeds policy.max_inputs ($max_inputs)"
    return 1
  fi

  pass "Selected inputs valid ($count input(s))"
  return 0
}

check_outputs() {
  local output_path="$1"
  local fixture_path="$2"

  # All fixture payments appear in outputs (multiset-aware: sort both, compare)
  local payments_missing
  payments_missing=$($JQ --slurpfile fixture "$fixture_path" '
    # Build sorted list of expected payments as "spk:value"
    def payment_keys: [.[] | "\(.script_pubkey_hex):\(.value_sats)"] | sort;

    # Expected from fixture
    ($fixture[0].payments | payment_keys) as $expected |
    # Actual non-change outputs
    ([.outputs[] | select(.is_change != true)] | payment_keys) as $actual |

    # Check each expected appears in actual (multiset check)
    # Reduce: for each expected key, remove first match from remaining actual
    reduce $expected[] as $e (
      { missing: [], remaining: $actual };
      (.remaining | index($e)) as $idx |
      if $idx != null then
        .remaining |= (.[0:$idx] + .[$idx+1:])
      else
        .missing += [$e]
      end
    ) | .missing | length
  ' "$output_path")

  if [[ "$payments_missing" -ne 0 ]]; then
    fail "Missing $payments_missing fixture payment(s) in outputs"
    return 1
  fi

  # At most 1 change output
  local change_count
  change_count=$($JQ '[.outputs[] | select(.is_change == true)] | length' "$output_path")
  if [[ "$change_count" -gt 1 ]]; then
    fail "Multiple change outputs found ($change_count)"
    return 1
  fi

  # change_index consistency
  local change_index
  change_index=$($JQ -r '.change_index // "null"' "$output_path")

  if [[ "$change_count" -eq 0 ]]; then
    if [[ "$change_index" != "null" ]]; then
      fail "change_index should be null when no change output (got: $change_index)"
      return 1
    fi
  else
    # Find actual position of change output
    local actual_index
    actual_index=$($JQ '
      [.outputs | to_entries[] | select(.value.is_change == true) | .key] | first
    ' "$output_path")
    if [[ "$change_index" != "$actual_index" ]]; then
      fail "change_index ($change_index) doesn't match actual change position ($actual_index)"
      return 1
    fi
  fi

  pass "Outputs valid (${change_count} change output(s))"
  return 0
}

check_balance_and_fee() {
  local output_path="$1"
  local fixture_path="$2"

  local result
  result=$($JQ --slurpfile fixture "$fixture_path" '
    # Sum selected input values (look up from fixture UTXOs)
    (.selected_inputs | map(
      . as $sel |
      $fixture[0].utxos[] | select(.txid == $sel.txid and .vout == $sel.vout) | .value_sats
    ) | add // 0) as $input_sum |

    # Sum output values
    (.outputs | map(.value_sats) | add // 0) as $output_sum |

    .fee_sats as $fee |
    .fee_rate_sat_vb as $reported_rate |
    .vbytes as $vbytes |
    $fixture[0].fee_rate_sat_vb as $target_rate |

    # Balance check: inputs == outputs + fee
    ($input_sum == $output_sum + $fee) as $balance_ok |

    # Fee meets target: fee >= ceil(vbytes * target_rate)
    # ceil(a*b) = integer part, but we allow equality with ceiling
    (($vbytes * $target_rate) | ceil) as $min_fee |
    ($fee >= $min_fee) as $fee_target_ok |

    # Fee rate accuracy: |fee/vbytes - reported_rate| <= 0.01
    (($fee / $vbytes) - $reported_rate | fabs) as $rate_diff |
    ($rate_diff <= 0.01) as $rate_ok |

    # No dust: every output >= 546 sats
    ([.outputs[] | select(.value_sats < 546)] | length) as $dust_count |

    {
      balance_ok: $balance_ok,
      fee_target_ok: $fee_target_ok,
      rate_ok: $rate_ok,
      dust_count: $dust_count,
      input_sum: $input_sum,
      output_sum: $output_sum,
      fee: $fee,
      min_fee: $min_fee,
      reported_rate: $reported_rate,
      actual_rate: ($fee / $vbytes),
      vbytes: $vbytes
    }
  ' "$output_path")

  local balance_ok fee_target_ok rate_ok dust_count
  balance_ok=$(echo "$result" | $JQ -r '.balance_ok')
  fee_target_ok=$(echo "$result" | $JQ -r '.fee_target_ok')
  rate_ok=$(echo "$result" | $JQ -r '.rate_ok')
  dust_count=$(echo "$result" | $JQ -r '.dust_count')

  local all_ok=true

  if [[ "$balance_ok" == "true" ]]; then
    pass "Balance equation: sum(inputs) == sum(outputs) + fee"
  else
    local input_sum output_sum fee
    input_sum=$(echo "$result" | $JQ -r '.input_sum')
    output_sum=$(echo "$result" | $JQ -r '.output_sum')
    fee=$(echo "$result" | $JQ -r '.fee')
    fail "Balance mismatch: inputs=$input_sum, outputs=$output_sum, fee=$fee"
    all_ok=false
  fi

  if [[ "$fee_target_ok" == "true" ]]; then
    pass "Fee meets target rate"
  else
    local fee min_fee
    fee=$(echo "$result" | $JQ -r '.fee')
    min_fee=$(echo "$result" | $JQ -r '.min_fee')
    fail "Fee too low: $fee < minimum $min_fee"
    all_ok=false
  fi

  if [[ "$rate_ok" == "true" ]]; then
    pass "Fee rate accuracy within tolerance"
  else
    local reported_rate actual_rate
    reported_rate=$(echo "$result" | $JQ -r '.reported_rate')
    actual_rate=$(echo "$result" | $JQ -r '.actual_rate')
    fail "Fee rate inaccurate: reported=$reported_rate, actual=$actual_rate"
    all_ok=false
  fi

  if [[ "$dust_count" -eq 0 ]]; then
    pass "No dust outputs"
  else
    fail "$dust_count output(s) below dust threshold (546 sats)"
    all_ok=false
  fi

  [[ "$all_ok" == "true" ]]
}

check_rbf_locktime() {
  local output_path="$1"

  local all_ok=true

  # rbf_signaling is boolean
  local rbf_type
  rbf_type=$($JQ -r '.rbf_signaling | type' "$output_path")
  if [[ "$rbf_type" == "boolean" ]]; then
    pass "rbf_signaling is boolean"
  else
    fail "rbf_signaling is $rbf_type (expected boolean)"
    all_ok=false
  fi

  # locktime is number
  local lt_type
  lt_type=$($JQ -r '.locktime | type' "$output_path")
  if [[ "$lt_type" == "number" ]]; then
    pass "locktime is number"
  else
    fail "locktime is $lt_type (expected number)"
    all_ok=false
  fi

  # locktime_type is one of the valid values
  local lt_type_val
  lt_type_val=$($JQ -r '.locktime_type' "$output_path")
  case "$lt_type_val" in
    none|block_height|unix_timestamp)
      pass "locktime_type is valid (\"$lt_type_val\")"
      ;;
    *)
      fail "locktime_type is \"$lt_type_val\" (expected none|block_height|unix_timestamp)"
      all_ok=false
      ;;
  esac

  [[ "$all_ok" == "true" ]]
}

check_warnings() {
  local output_path="$1"

  local all_ok=true

  # Extract warning codes from output
  local warning_codes
  warning_codes=$($JQ -r '[.warnings[]?.code] | join(",")' "$output_path")

  has_warning() {
    echo ",$warning_codes," | grep -q ",$1,"
  }

  # No change → SEND_ALL required
  local change_count
  change_count=$($JQ '[.outputs[] | select(.is_change == true)] | length' "$output_path")
  if [[ "$change_count" -eq 0 ]]; then
    if has_warning "SEND_ALL"; then
      pass "SEND_ALL warning present (no change output)"
    else
      fail "SEND_ALL warning missing (no change output)"
      all_ok=false
    fi
  fi

  # HIGH_FEE checks
  local needs_high_fee
  needs_high_fee=$($JQ '
    (.fee_sats > 1000000) or (.fee_rate_sat_vb > 200)
  ' "$output_path")
  if [[ "$needs_high_fee" == "true" ]]; then
    if has_warning "HIGH_FEE"; then
      pass "HIGH_FEE warning present"
    else
      fail "HIGH_FEE warning missing (fee_sats > 1M or fee_rate > 200)"
      all_ok=false
    fi
  fi

  # RBF_SIGNALING check
  local rbf_signaling
  rbf_signaling=$($JQ -r '.rbf_signaling' "$output_path")
  if [[ "$rbf_signaling" == "true" ]]; then
    if has_warning "RBF_SIGNALING"; then
      pass "RBF_SIGNALING warning present"
    else
      fail "RBF_SIGNALING warning missing (rbf_signaling is true)"
      all_ok=false
    fi
  fi

  # If none of the conditional checks triggered, just validate warnings is an array
  local warnings_type
  warnings_type=$($JQ -r '.warnings | type' "$output_path")
  if [[ "$warnings_type" == "array" ]]; then
    pass "warnings is a valid array"
  else
    fail "warnings is $warnings_type (expected array)"
    all_ok=false
  fi

  [[ "$all_ok" == "true" ]]
}

check_psbt() {
  local output_path="$1"

  local psbt
  psbt=$($JQ -r '.psbt_base64' "$output_path")

  if [[ -z "$psbt" ]] || [[ "$psbt" == "null" ]]; then
    fail "psbt_base64 is empty or null"
    return 1
  fi

  # Base64 decode succeeds
  local raw
  if ! raw=$(echo "$psbt" | base64 $B64_DECODE 2>/dev/null); then
    fail "psbt_base64 is not valid base64"
    return 1
  fi

  # First 5 bytes = psbt magic: 70736274ff
  local magic
  magic=$(echo "$psbt" | base64 $B64_DECODE 2>/dev/null | xxd -p -l 5)
  if [[ "$magic" == "70736274ff" ]]; then
    pass "PSBT magic bytes valid (psbt\\xff)"
  else
    fail "PSBT magic bytes invalid: $magic (expected 70736274ff)"
    return 1
  fi

  return 0
}

# ── Per-fixture driver ───────────────────────────────────────────────────────

run_fixture() {
  local fixture_path="$1"
  local name
  name=$(basename "$fixture_path" .json)
  local output_path="$OUT_DIR/$name.json"

  printf "\n${BOLD}=== %s ===${RESET}\n" "$name"

  local fixture_pass=0
  local fixture_fail=0

  # A. CLI exit
  if ! check_cli_exit "$fixture_path"; then
    printf "  ${RED}FAIL${RESET} (%d/%d)\n" "$fixture_pass" "$((fixture_pass + fixture_fail))"
    ((FAILED_FIXTURES++)) || true
    return
  fi

  # B. Output exists and is valid JSON
  if ! check_output_exists "$output_path"; then
    printf "  ${RED}FAIL${RESET} (%d/%d)\n" "$fixture_pass" "$((fixture_pass + fixture_fail))"
    ((FAILED_FIXTURES++)) || true
    return
  fi

  # C. Required fields
  check_required_fields "$output_path" || true

  # D. Selected inputs
  check_selected_inputs "$output_path" "$fixture_path" || true

  # E. Outputs
  check_outputs "$output_path" "$fixture_path" || true

  # F. Balance and fee
  check_balance_and_fee "$output_path" "$fixture_path" || true

  # G. RBF / locktime types
  check_rbf_locktime "$output_path" || true

  # H. Warnings
  check_warnings "$output_path" || true

  # I. PSBT validation
  check_psbt "$output_path" || true

  # Per-fixture summary
  local total=$((fixture_pass + fixture_fail))
  if [[ "$fixture_fail" -eq 0 ]]; then
    printf "  ${GREEN}PASS${RESET} (%d/%d)\n" "$fixture_pass" "$total"
    ((PASSED_FIXTURES++)) || true
  else
    printf "  ${RED}FAIL${RESET} (%d/%d)\n" "$fixture_pass" "$total"
    ((FAILED_FIXTURES++)) || true
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────

printf "\n${BOLD}Coin Smith PSBT Builder — Grader${RESET}\n"
printf "=================================\n"

# Clean output directory
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Run setup if exists
if [[ -f "setup.sh" ]]; then
  printf "\nRunning setup.sh...\n"
  bash setup.sh >/dev/null 2>&1 || true
fi

# Make cli.sh executable
chmod +x cli.sh 2>/dev/null || true

# Loop over all fixtures
for fixture in "$FIXTURES_DIR"/*.json; do
  [[ -f "$fixture" ]] || continue
  ((TOTAL_FIXTURES++)) || true
  run_fixture "$fixture"
done

# Summary
printf "\n${BOLD}=== SUMMARY ===${RESET}\n"
printf "  %d/%d fixtures passed\n" "$PASSED_FIXTURES" "$TOTAL_FIXTURES"

if [[ "$FAILED_FIXTURES" -eq 0 ]]; then
  printf "  ${GREEN}All fixtures passed!${RESET}\n\n"
  exit 0
else
  printf "  ${RED}%d fixture(s) failed.${RESET}\n\n" "$FAILED_FIXTURES"
  exit 1
fi
