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

# Tests that need the status_probe helper binary
HELPER_TESTS := *execution*|*exit_status*|*signals*|*monitor*

# waitpid() failure-policy probe (links the non-main objects directly)
WAIT_HELPER := $(BUILD)/wait_probe
WAIT_TESTS  := *waitpolicy*

# Sanitizer build (AddressSanitizer + UndefinedBehaviorSanitizer)
SAN_TARGET := caps-asan
SAN_FLAGS  := -fsanitize=address,undefined -fno-omit-frame-pointer

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(LDFLAGS) -o $@ $(OBJS) $(LDLIBS)

$(BUILD)/%.o: src/%.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c -o $@ $<

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

clean:
	rm -rf $(BUILD) $(TARGET) $(SAN_TARGET)

-include $(DEPS)

.PHONY: all run test test-asan clean web web-backend web-frontend web-install

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
