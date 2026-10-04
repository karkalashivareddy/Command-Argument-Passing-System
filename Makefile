CC      := cc
CPPFLAGS := -Iinclude -D_POSIX_C_SOURCE=200809L
CFLAGS  := -std=c11 -Wall -Wextra -Wpedantic -g
LDFLAGS :=
LDLIBS  :=

BUILD   := build
TARGET  := caps
VERSION_HEADER := include/version.h

# src/pidfd.c is deliberately excluded from the engine. It is its own
# executable (build/caps_pidfd), because Node has no pidfd API and the gateway
# execs this helper rather than linking it. Globbing it into SRCS gave the
# binary two `main` definitions and broke the link.
SRCS    := $(filter-out src/pidfd.c,$(wildcard src/*.c))
OBJS    := $(SRCS:src/%.c=$(BUILD)/%.o)
DEPS    := $(OBJS:.o=.d)

# Controlled first-party laboratory workloads (see docs/workload-lab.md).
# They are real Linux programs built by this repository; the gateway
# resolves them through explicit repository-relative paths and never
# accepts an arbitrary executable path from the browser.
WORKLOAD_DIR      := workloads
WORKLOAD_BIN_DIR  := build/workloads
WORKLOAD_SRCS     := $(wildcard $(WORKLOAD_DIR)/*.c)
WORKLOAD_BINS     := $(patsubst $(WORKLOAD_DIR)/%.c,$(WORKLOAD_BIN_DIR)/%,$(WORKLOAD_SRCS))
WL_CPPFLAGS       := -I$(WORKLOAD_DIR) -D_POSIX_C_SOURCE=200809L

# Test harness
TESTS   := tests/test_smoke.sh \
           tests/test_parser.sh \
           tests/test_execution.sh \
           tests/test_errors.sh \
           tests/test_exit_status.sh \
           tests/test_signals.sh \
           tests/test_redirection.sh \
           tests/test_exit_parse.sh \
           tests/test_fd_edge.sh \
           tests/test_monitor.sh \
           tests/test_lifecycle.sh \
           tests/test_waitpolicy.sh \
           tests/test_wait_failure.sh \
           tests/test_pipeline.sh
HELPER  := $(BUILD)/status_probe
PIDFD   := $(BUILD)/caps_pidfd
# A real zombie cannot be produced from a shell: bash reaps its own jobs and an
# orphaned child is re-parented to init, which reaps it at once. This helper
# holds an unreaped child so the zombie assertions actually execute instead of
# being skipped.
ZOMBIE  := $(BUILD)/zombie_maker
# The producer half of the pipeline SIGPIPE test. Separate from status_probe
# because its whole value is that it does ONE thing and has no signal handler:
# a helper that also raised signals elsewhere could not prove that the engine's
# child disposition is what killed it.
SIGPIPE_WRITER := $(BUILD)/sigpipe_writer
PIDFD_TESTS := tests/test_pidfd.sh
# Asserts on the CHILD's own /proc/<pid>/limits, so it needs the engine but no
# helper binary.
LIMIT_TESTS := tests/test_limits.sh

# Controlled-workload tests (run the real workload binaries)
WL_TESTS := tests/workloads/test_workloads.sh

# Repository-tooling gates and their own tests.  Two halves, and both matter:
#
#   * each gate run against the real repository -- a gate nobody ever executes
#     on real input is a claim, not a check;
#   * each gate run against throwaway fixtures, including deliberately broken
#     ones -- a gate that always passes is just as useless, and only a fixture
#     that must fail can tell those two cases apart.
#
# These are kept out of $(TESTS) because that loop passes the engine binary to
# each case, which a gate over git metadata or version strings neither needs nor
# accepts.  check-version.test.sh resolves its own gate from its own location;
# the extra argument is harmless and keeps one loop for both.
GATE_TESTS := tests/scripts/test_attribution.sh \
              scripts/check-version.test.sh

GATES := scripts/check-attribution.sh \
         scripts/check-version.sh \
         scripts/check-docs.sh


# Tests that need the status_probe helper binary
HELPER_TESTS := *execution*|*exit_status*|*signals*|*monitor*

# The pipeline suite drives a controlled producer binary to prove the child's
# SIGPIPE disposition. It gets that binary instead of status_probe because a
# producer with no signal handler is the thing under test.
PIPELINE_TESTS := *pipeline*

# waitpid() failure-policy probes (link the non-main objects directly)
WAIT_HELPER := $(BUILD)/wait_probe
WAIT_TESTS  := *waitpolicy*|*wait_failure*

# Sanitizer build (AddressSanitizer + UndefinedBehaviorSanitizer)
SAN_TARGET := caps-asan
SAN_FLAGS  := -fsanitize=address,undefined -fno-omit-frame-pointer

# Sanitizer build of every controlled workload
WL_SAN_DIR   := build/workloads-asan
WL_SAN_BINS  := $(patsubst $(WORKLOAD_DIR)/%.c,$(WL_SAN_DIR)/%,$(WORKLOAD_SRCS))

# The lifecycle suite needs no helper binary, but the parser cases chdir into
# a scratch directory and must be able to find the engine again afterwards.
LIFECYCLE_TESTS := *lifecycle*

# The product version has one canonical source (PRODUCT_VERSION in
# web/backend/src/config/env.ts).  It is projected into the C engine so
# caps --version and the running gateway cannot describe different products.
VERSION_SRC := web/backend/src/config/env.ts

all: $(TARGET) workloads

version:
	@sh scripts/generate-version.sh

$(VERSION_HEADER): $(VERSION_SRC) scripts/generate-version.sh
	@sh scripts/generate-version.sh

$(TARGET): $(OBJS)
	$(CC) $(LDFLAGS) -o $@ $(OBJS) $(LDLIBS)

$(BUILD)/%.o: src/%.c $(VERSION_HEADER) | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c -o $@ $<

# ---------------------------------------------------------------- workloads
# Each workload is an independent binary: no shared library, no coupling
# to the CAPS engine.  `make` builds them so the gateway's capability
# probe reports the truth instead of a guess.

workloads: $(WORKLOAD_BINS)

$(WORKLOAD_BIN_DIR)/%: $(WORKLOAD_DIR)/%.c $(WORKLOAD_DIR)/workload_common.h | $(WORKLOAD_BIN_DIR)
	$(CC) $(WL_CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ $< $(LDLIBS)

$(WORKLOAD_BIN_DIR):
	mkdir -p $(WORKLOAD_BIN_DIR)

$(HELPER): tests/helpers/status_probe.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ $<

# The pidfd capability probe and PID-reuse-safe signal delivery. The gateway
# has no native pidfd API, so it execs this helper; signals are rare enough that
# the exec cost is irrelevant next to addressing the right process.
$(PIDFD): src/pidfd.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ $<

$(ZOMBIE): tests/helpers/zombie_maker.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ $<

$(SIGPIPE_WRITER): tests/helpers/sigpipe_writer.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ $<

tests/test_pidfd.sh: $(PIDFD)

# Links the execution objects (minus main) so the probe can call
# process_wait_child() directly.
WAIT_OBJS := $(filter-out $(BUILD)/main.o,$(OBJS))

$(WAIT_HELPER): tests/helpers/wait_probe.c $(WAIT_OBJS) | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ tests/helpers/wait_probe.c $(WAIT_OBJS)

# The gateway suite drives the real engine against the status probe, so it
# needs the helper binaries that only the test targets used to build. Exposed
# as its own target so a job that runs the suite without `make test` still
# gets a runnable fixture instead of a session that can never start.
test-helpers: $(HELPER) $(WAIT_HELPER) $(PIDFD) $(ZOMBIE) $(SIGPIPE_WRITER)

$(BUILD):
	mkdir -p $(BUILD)

run: $(TARGET)
	./$(TARGET)

# The limits suite exercises caps_memory_burn, so it depends on `workloads`.
test: $(TARGET) $(HELPER) $(WAIT_HELPER) $(PIDFD) $(ZOMBIE) $(SIGPIPE_WRITER) $(WORKLOAD_BINS)
	@set -e; for t in $(TESTS) $(PIDFD_TESTS) $(LIMIT_TESTS); do \
		echo "== $$t =="; \
		case "$$t" in \
			$(WAIT_TESTS)) ./$$t ./$(WAIT_HELPER);; \
			$(PIPELINE_TESTS)) ./$$t ./$(TARGET) ./$(SIGPIPE_WRITER);; \
			tests/test_pidfd.sh) ./$$t ./$(PIDFD) ./$(ZOMBIE);; \
			$(HELPER_TESTS)) ./$$t ./$(TARGET) ./$(HELPER);; \
			*) ./$$t ./$(TARGET);; \
		esac; \
	done; \
	echo "ALL TESTS PASSED"

# Controlled workloads are exercised against the real binaries so the
# gateway's capability probe and the E2E suite observe the same program.
test-workloads: workloads
	@set -e; for t in $(WL_TESTS); do \
		echo "== $$t =="; \
		./$$t $(WORKLOAD_BIN_DIR); \
	done; \
	echo "ALL WORKLOAD TESTS PASSED"

# Repository-tooling gates.  The attribution gate is run over the real history
# first, so a contaminated commit fails here exactly as it fails in CI, and
# then over synthetic fixtures that pin which identities it must accept and
# which it must reject.
test-scripts:
	@set -e; \
	for g in $(GATES); do \
		echo "== $$g (real repository) =="; \
		sh $$g; \
	done; \
	for t in $(GATE_TESTS); do \
		echo "== $$t =="; \
		sh $$t scripts/check-attribution.sh; \
	done; \
	echo "ALL SCRIPT TESTS PASSED"

# AddressSanitizer + UBSan build (rebuilds sources directly into one binary)
$(SAN_TARGET): $(SRCS) include/*.h $(VERSION_HEADER)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(SAN_FLAGS) -o $@ $(SRCS)

# The pidfd and limits suites run against the sanitized engine too. Both drive
# real child processes, so they exercise the fork/exec path that ASan is
# instrumented to watch -- which is the point of running them at all.
test-asan: $(SAN_TARGET) $(HELPER) $(WAIT_HELPER) $(PIDFD) $(ZOMBIE) $(SIGPIPE_WRITER) $(WORKLOAD_BINS)
	@set -e; for t in $(TESTS) $(PIDFD_TESTS) $(LIMIT_TESTS); do \
		echo "== $$t (asan) =="; \
		case "$$t" in \
			$(WAIT_TESTS)) ASAN_OPTIONS="$(WL_ASAN_OPTIONS)" ./$$t ./$(WAIT_HELPER);; \
			tests/test_pidfd.sh) ASAN_OPTIONS="$(WL_ASAN_OPTIONS)" ./$$t ./$(PIDFD) ./$(ZOMBIE);; \
			$(PIPELINE_TESTS)) ASAN_OPTIONS="$(WL_ASAN_OPTIONS)" ./$$t ./$(SAN_TARGET) ./$(SIGPIPE_WRITER);; \
			$(HELPER_TESTS)) ASAN_OPTIONS="$(WL_ASAN_OPTIONS)" ./$$t ./$(SAN_TARGET) ./$(HELPER);; \
			*) ASAN_OPTIONS="$(WL_ASAN_OPTIONS)" ./$$t ./$(SAN_TARGET);; \
		esac; \
	done; \
	echo "ALL ASAN TESTS PASSED"

# Sanitizer build of the controlled workloads, then the same test suite.
# Leak detection matters most here: every workload owns a workspace and,
# for the memory/mixed cases, an anonymous mapping.
# ASan options for the workload suite.
#
# allocator_may_return_null=1 and hard_rss_limit_mb are not cosmetic. ASan
# reserves a large shadow region and its allocator aborts the process on a failed
# allocation by default. In a memory-constrained environment -- WSL2, a
# container, a small CI runner -- five instrumented workloads run back to back
# can exhaust that budget, and the result is not a failed test but the loss of
# the whole VM. Capping the allocator converts an unrecoverable environment
# failure into an ordinary test failure that can be read and acted on.
#
# detect_leaks=1 is deliberate for these binaries: each workload is a short-lived
# program that allocates and frees in a loop, so a leak is a real finding, and the
# programs are small enough that leak checking is cheap.
WL_ASAN_OPTIONS := allocator_may_return_null=1:hard_rss_limit_mb=1024:detect_leaks=1

test-workloads-asan: $(WL_SAN_BINS)
	@set -e; for t in $(WL_TESTS); do \
		echo "== $$t (asan) =="; \
		ASAN_OPTIONS="$(WL_ASAN_OPTIONS)" UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=0 ./$$t $(WL_SAN_DIR); \
	done; \
	echo "ALL WORKLOAD ASAN TESTS PASSED"

clean:
	rm -rf $(BUILD) $(TARGET) $(SAN_TARGET)

-include $(DEPS)

.PHONY: all version workloads run test test-scripts test-workloads test-asan \
        test-workloads-asan clean web web-backend web-frontend web-install

$(WL_SAN_DIR):
	mkdir -p $(WL_SAN_DIR)

$(WL_SAN_DIR)/%: $(WORKLOAD_DIR)/%.c $(WORKLOAD_DIR)/workload_common.h | $(WL_SAN_DIR)
	$(CC) $(WL_CPPFLAGS) $(CFLAGS) $(SAN_FLAGS) $(LDFLAGS) -o $@ $< $(LDLIBS)

# Start the full observatory stack (backend + frontend dev servers)
# Requires: make caps (C engine built), then run from repo root
web: web-backend web-frontend

# Start backend only (needs CAPS_DATABASE_PATH and CAPS_WORKSPACE)
web-backend:
	@cd web/backend && \
	CAPS_DATABASE_PATH=/tmp/caps-web.db CAPS_WORKSPACE=/tmp/caps-web-work CAPS_LOG_LEVEL=info \
	node --disable-warning=ExperimentalWarning --import tsx src/server.ts

# Start frontend only (Vite dev server)
web-frontend:
	@cd web/frontend && npm run dev -- --host 127.0.0.1 --port 5173

# Install frontend deps (run once before web-frontend)
web-install:
	@cd web/frontend && npm install --no-fund --no-audit
