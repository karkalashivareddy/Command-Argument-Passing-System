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

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(LDFLAGS) -o $@ $(OBJS) $(LDLIBS)

$(BUILD)/%.o: src/%.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c -o $@ $<

$(BUILD):
	mkdir -p $(BUILD)

run: $(TARGET)
	./$(TARGET)

test: $(TARGET)
	./tests/test_smoke.sh ./$(TARGET)

clean:
	rm -rf $(BUILD) $(TARGET)

-include $(DEPS)

.PHONY: all run test clean