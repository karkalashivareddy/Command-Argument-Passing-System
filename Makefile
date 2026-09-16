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
           tests/test_redirection.sh
HELPER  := $(BUILD)/status_probe

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

$(BUILD):
	mkdir -p $(BUILD)

run: $(TARGET)
	./$(TARGET)

test: $(TARGET) $(HELPER)
	@set -e; for t in $(TESTS); do \
		echo "== $$t =="; \
		case "$$t" in \
			*execution*|*exit_status*|*signals*) ./$$t ./$(TARGET) ./$(HELPER);; \
			*) ./$$t ./$(TARGET);; \
		esac; \
	done; \
	echo "ALL TESTS PASSED"

# AddressSanitizer + UBSan build (rebuilds sources directly into one binary)
$(SAN_TARGET): $(SRCS) include/*.h
	$(CC) $(CPPFLAGS) $(CFLAGS) $(SAN_FLAGS) -o $@ $(SRCS)

test-asan: $(SAN_TARGET) $(HELPER)
	@set -e; for t in $(TESTS); do \
		echo "== $$t (asan) =="; \
		case "$$t" in \
			*execution*|*exit_status*|*signals*) ASAN_OPTIONS=detect_leaks=1 ./$$t ./$(SAN_TARGET) ./$(HELPER);; \
			*) ASAN_OPTIONS=detect_leaks=1 ./$$t ./$(SAN_TARGET);; \
		esac; \
	done; \
	echo "ALL ASAN TESTS PASSED"

clean:
	rm -rf $(BUILD) $(TARGET) $(SAN_TARGET)

-include $(DEPS)

.PHONY: all run test test-asan clean