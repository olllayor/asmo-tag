#!/usr/bin/env bash
# verify-guardrails.sh
# Deterministic pre-gate script for autonomous agent swarms.
# Enforces anti-shortcut rules, detects comment rationalizations, and runs objective gates.

set -euo pipefail

BASE_REF="${1:-HEAD~1}"

echo "=========================================================="
echo " Running Swarm Guardrail Verification against ${BASE_REF}"
echo "=========================================================="

# 1. Anti-Shortcut Check: Forbid stub macros and bypass annotations in source and test files
echo "==> [Check 1/3] Scanning for forbidden stub and bypass tokens in source/test files..."
FORBIDDEN_PATTERN='\btodo!\(\)|\bunimplemented!\(\)|\bFIXME:?\b|\bSTUB\b|\bas any\b|@ts-ignore|@ts-nocheck'

# Only scan source and test code files, ignoring documentation / markdown files
SOURCE_DIFF=$(git diff "${BASE_REF}" -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.rs' '*.zig' 2>/dev/null || true)

if [ -n "${SOURCE_DIFF}" ] && echo "${SOURCE_DIFF}" | grep -E "${FORBIDDEN_PATTERN}"; then
    echo "❌ ERROR: Disallowed placeholder macro or type bypass token detected in code diff!" >&2
    echo "Agents are strictly prohibited from stubbing implementations or bypassing types." >&2
    exit 1
fi
echo "✓ No placeholder stubs detected."

# 2. The Rationalization Rule: Flag suspicious comment blocks
echo "==> [Check 2/3] Analyzing comment density and rationalization heuristics..."
# Measures comment lines added in code files
COMMENT_LINES=$(git diff "${BASE_REF}" -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.rs' '*.zig' | grep -E '^\+(\s*//|\s*\*|\s*#)' | wc -l || true)
CODE_LINES=$(git diff "${BASE_REF}" -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.rs' '*.zig' | grep -E '^\+[^+]' | wc -l || true)

if [ "${CODE_LINES}" -gt 0 ]; then
    COMMENT_RATIO=$(( COMMENT_LINES * 100 / CODE_LINES ))
    if [ "${COMMENT_RATIO}" -gt 40 ] && [ "${COMMENT_LINES}" -gt 20 ]; then
        echo "⚠️ WARNING: Abnormally high comment density detected (${COMMENT_RATIO}% comments, ${COMMENT_LINES} comment lines)." >&2
        echo "Rule: 'If you need a paragraph-long comment to justify why a workaround is OK, the code is wrong — fix the code.'" >&2
        echo "Flagging for mandatory adversarial reviewer audit."
    fi
fi
echo "✓ Comment heuristic passed."

# 3. Objective Gate: Run project compiler & test suite
echo "==> [Check 3/3] Running deterministic compiler and test gates..."
if [ -f "package.json" ]; then
    if grep -q '"check"' package.json; then
        echo "Running TypeScript typecheck (pnpm run check)..."
        pnpm run check
    fi
    if grep -q '"test"' package.json; then
        echo "Running immutable test suite (pnpm test)..."
        pnpm test
    fi
elif [ -f "Cargo.toml" ]; then
    echo "Running Rust compiler check (cargo check)..."
    cargo check --workspace --all-targets
    echo "Running Cargo tests..."
    cargo test
fi

echo "=========================================================="
echo " ✅ All Swarm Guardrails & Objective Gates PASSED"
echo "=========================================================="
