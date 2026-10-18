#!/usr/bin/env bash
# Keep the command in this Linux shell's cwd, environment and cgroup.
# The control program only holds a lease through private pipes.
set -u
heavy=0
gate_args=(gate-hold)
while (($#)); do
    case "$1" in
        --heavy) heavy=1; shift ;;
        --label) if (($# < 2)); then echo 'Missing --label value' >&2; exit 2; fi; gate_args+=(--label "$2"); shift 2 ;;
        --) shift; break ;;
        *) echo 'Usage: bash "$CC_PANES_RUN" [--heavy] [--label text] -- command args...' >&2; exit 2 ;;
    esac
done
if (($# == 0)); then echo 'Missing command' >&2; exit 2; fi
if ((heavy == 0)); then exec "$@"; fi
if [[ -z ${CC_PANES_CTL:-} ]]; then
    echo '[cc-panes] Control program unavailable; executing locally' >&2
    exec "$@"
fi
gate_dir=$(mktemp -d "${TMPDIR:-/tmp}/cc-panes-run.XXXXXXXX") || exit 1
gate_pid=''
gate_open=0
gate_ready=0
started=$SECONDS
cleanup() {
    local code=$?
    if ((gate_open)); then
        { printf '%s %s\n' "$code" "$(( (SECONDS-started)*1000 ))" >&3; } 2>/dev/null || :
        exec 3>&-
    fi
    if [[ -n $gate_pid ]]; then
        if ((gate_ready)); then wait "$gate_pid" || :; else kill "$gate_pid" 2>/dev/null || :; fi
    fi
    rm -rf -- "$gate_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkfifo "$gate_dir/in" "$gate_dir/out" || exit 1
# Open in matching order. The child opens both pipes before exec, so even an
# unavailable/old ctl closes the output pipe and read reports failure.
"$CC_PANES_CTL" "${gate_args[@]}" -- "$@" <"$gate_dir/in" >"$gate_dir/out" &
gate_pid=$!
exec 3>"$gate_dir/in"
gate_open=1
exec 4<"$gate_dir/out"
if IFS= read -r reply <&4 && [[ $reply == CCPANES_GATE_READY ]]; then
    gate_ready=1
else
    echo '[cc-panes] Gate holder unavailable; executing locally' >&2
fi
exec 4<&-
started=$SECONDS
# A long-lived descendant must not inherit the lease pipe and prevent EOF.
"$@" 3>&-
exit $?
