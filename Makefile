CC      := cc
CPPFLAGS := -Iinclude -D_POSIX_C_SOURCE=200809L
CFLAGS  := -std=c11 -Wall -Wextra -Wpedantic -g
LDFLAGS :=
LDLIBS  :=

BUILD   := build
TARGET  := caps

SRCS    := $(wildcard src/*.c)
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
           tests/test_waitpolicy.sh
HELPER  := $(BUILD)/status_probe

# Controlled-workload tests (run the real workload binaries)
WL_TESTS := tests/workloads/test_workloads.sh

# Tests that need the status_probe helper binary
HELPER_TESTS := *execution*|*exit_status*|*signals*|*monitor*

# waitpid() failure-policy probe (links the non-main objects directly)
WAIT_HELPER := $(BUILD)/wait_probe
WAIT_TESTS  := *waitpolicy*

# Sanitizer build (AddressSanitizer + UndefinedBehaviorSanitizer)
SAN_TARGET := caps-asan
SAN_FLAGS  := -fsanitize=address,undefined -fno-omit-frame-pointer

# Sanitizer build of every controlled workload
WL_SAN_DIR   := build/workloads-asan
WL_SAN_BINS  := $(patsubst $(WORKLOAD_DIR)/%.c,$(WL_SAN_DIR)/%,$(WORKLOAD_SRCS))

all: $(TARGET) workloads

$(TARGET): $(OBJS)
	$(CC) $(LDFLAGS) -o $@ $(OBJS) $(LDLIBS)

$(BUILD)/%.o: src/%.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c -o $@ $<

# ---------------------------------------------------------------- workloads
# Each workload is an independent binary: no shared library, no coupling
# to the CAPS engine.  `make` builds them so the gateway's capability
# probe reports the truth instead of a guess.

caps: $(TARGET)

workloads: $(WORKLOAD_BINS)

$(WORKLOAD_BIN_DIR)/%: $(WORKLOAD_DIR)/%.c $(WORKLOAD_DIR)/workload_common.h | $(WORKLOAD_BIN_DIR)
	$(CC) $(WL_CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ $< $(LDLIBS)

$(WORKLOAD_BIN_DIR):
	mkdir -p $(WORKLOAD_BIN_DIR)

$(HELPER): tests/helpers/status_probe.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ $<

# Links the execution objects (minus main) so the probe can call
# process_wait_child() directly.
WAIT_OBJS := $(filter-out $(BUILD)/main.o,$(OBJS))

$(WAIT_HELPER): tests/helpers/wait_probe.c $(WAIT_OBJS) | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ tests/helpers/wait_probe.c $(WAIT_OBJS)

$(BUILD):
	mkdir -p $(BUILD)

run: $(TARGET)
	./$(TARGET)

test: $(TARGET) $(HELPER) $(WAIT_HELPER)
	@set -e; for t in $(TESTS); do \
		echo "== $$t =="; \
		case "$$t" in \
			$(WAIT_TESTS)) ./$$t ./$(WAIT_HELPER);; \
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

# AddressSanitizer + UBSan build (rebuilds sources directly into one binary)
$(SAN_TARGET): $(SRCS) include/*.h
	$(CC) $(CPPFLAGS) $(CFLAGS) $(SAN_FLAGS) -o $@ $(SRCS)

test-asan: $(SAN_TARGET) $(HELPER) $(WAIT_HELPER)
	@set -e; for t in $(TESTS); do \
		echo "== $$t (asan) =="; \
		case "$$t" in \
			$(WAIT_TESTS)) ASAN_OPTIONS=detect_leaks=1 ./$$t ./$(WAIT_HELPER);; \
			$(HELPER_TESTS)) ASAN_OPTIONS=detect_leaks=1 ./$$t ./$(SAN_TARGET) ./$(HELPER);; \
			*) ASAN_OPTIONS=detect_leaks=1 ./$$t ./$(SAN_TARGET);; \
		esac; \
	done; \
	echo "ALL ASAN TESTS PASSED"

# Sanitizer build of the controlled workloads, then the same test suite.
# Leak detection matters most here: every workload owns a workspace and,
# for the memory/mixed cases, an anonymous mapping.
test-workloads-asan: $(WL_SAN_BINS)
	@set -e; for t in $(WL_TESTS); do \
		echo "== $$t (asan) =="; \
		ASAN_OPTIONS=detect_leaks=1 ./$$t $(WL_SAN_DIR); \
	done; \
	echo "ALL WORKLOAD ASAN TESTS PASSED"

clean:
	rm -rf $(BUILD) $(TARGET) $(SAN_TARGET)

-include $(DEPS)

.PHONY: all caps workloads run test test-workloads test-asan \
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
