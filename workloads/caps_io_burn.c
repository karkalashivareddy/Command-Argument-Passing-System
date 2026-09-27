/*
 * caps_io_burn — controlled file-I/O workload.
 *
 *   caps_io_burn <seconds> <mib>
 *
 * Purpose: make /proc/<pid>/io report non-zero read_bytes / write_bytes
 * for a CAPS-owned process so the I/O telemetry in the observatory has a
 * real source.  The workload writes a bounded, deterministic byte pattern
 * to one file inside a bounded private workspace and reads it back.
 *
 * Workspace confinement:
 *   - the path is derived from mkdtemp() under TMPDIR (or /tmp)
 *   - it is NOT taken from argv, so no path traversal is possible
 *   - the whole tree is removed on every exit path, including signals
 *   - total bytes written are capped at <mib> (1..64)
 *   - the file size never exceeds the cap, so the host is never flooded
 *
 * Guarantees:
 *   - no shell, no network, no /dev access, no system file modification
 *   - no unbounded output (a few status lines)
 *   - clean exit on SIGINT/SIGTERM
 *
 * This is a controlled laboratory workload.
 */

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include "workload_common.h"

volatile sig_atomic_t caps_wl_stop = 0;

#define CAPS_WL_BLOCK (64 * 1024)

/* Fixed, non-random pattern so the workload is deterministic. */
static void fill_block(unsigned char *buf, size_t len, size_t offset)
{
    for (size_t i = 0; i < len; i++)
        buf[i] = (unsigned char)(((offset + i) * 31u + 7u) & 0xffu);
}

/* Recursively remove the private workspace (bounded: only one level). */
static void remove_workspace(const char *dir)
{
    DIR *d = opendir(dir);
    struct dirent *ent;

    if (d == NULL)
        return;
    while ((ent = readdir(d)) != NULL) {
        char path[4096];
        struct stat info;

        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0)
            continue;
        if (snprintf(path, sizeof path, "%s/%s", dir, ent->d_name) < 0)
            continue;
        if (lstat(path, &info) != 0)
            continue;
        if (S_ISDIR(info.st_mode))
            remove_workspace(path);
        else
            (void)unlink(path);
    }
    closedir(d);
    (void)rmdir(dir);
}

int main(int argc, char **argv)
{
    long seconds = 10;
    long mib = 8;
    long long start_ms, deadline_ms, elapsed_ms;
    long long cap_bytes;
    long long total_written = 0;
    long long total_read = 0;
    const char *tmp = getenv("TMPDIR");
    char dir_template[4096];
    char file_path[4200];
    unsigned char *block = NULL;
    int fd = -1;
    int rc = 0;

    if (argc > 1 && caps_wl_parse_bounded(argv[1], CAPS_WL_MIN_DURATION_S,
                                          CAPS_WL_MAX_DURATION_S, &seconds) != 0) {
        caps_wl_usage(argv[0], "<seconds> <mib>",
                      "duration must be an integer 1..30 (controlled workload)");
        return CAPS_WL_EXIT_USAGE;
    }
    if (argc > 2 && caps_wl_parse_bounded(argv[2], 1, CAPS_WL_MAX_IO_MIB,
                                          &mib) != 0) {
        caps_wl_usage(argv[0], "<seconds> <mib>",
                      "workspace size must be an integer 1..64 MiB");
        return CAPS_WL_EXIT_USAGE;
    }
    if (argc > 3) {
        caps_wl_usage(argv[0], "<seconds> <mib>",
                      "this workload accepts at most two arguments");
        return CAPS_WL_EXIT_USAGE;
    }

    if (caps_wl_install_stop_handlers() != 0) {
        fprintf(stderr, "caps_io_burn: cannot install stop handlers: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }

    if (tmp == NULL || tmp[0] == '\0')
        tmp = "/tmp";
    if (snprintf(dir_template, sizeof dir_template, "%s/caps-io-XXXXXX", tmp) >=
        (int)sizeof dir_template) {
        fprintf(stderr, "caps_io_burn: TMPDIR path is too long\n");
        return CAPS_WL_EXIT_SETUP;
    }

    if (mkdtemp(dir_template) == NULL) {
        fprintf(stderr, "caps_io_burn: cannot create workspace under %s: %s\n",
                tmp, strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }

    if (snprintf(file_path, sizeof file_path, "%s/workload.dat", dir_template) >=
        (int)sizeof file_path) {
        fprintf(stderr, "caps_io_burn: workspace path is too long\n");
        remove_workspace(dir_template);
        return CAPS_WL_EXIT_SETUP;
    }

    block = malloc(CAPS_WL_BLOCK);
    if (block == NULL) {
        fprintf(stderr, "caps_io_burn: out of memory\n");
        remove_workspace(dir_template);
        return CAPS_WL_EXIT_SETUP;
    }

    fd = open(file_path, O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        fprintf(stderr, "caps_io_burn: cannot open workspace file: %s\n",
                strerror(errno));
        free(block);
        remove_workspace(dir_template);
        return CAPS_WL_EXIT_SETUP;
    }

    start_ms = caps_wl_monotonic_ms();
    if (start_ms < 0) {
        (void)close(fd);
        free(block);
        remove_workspace(dir_template);
        fprintf(stderr, "caps_io_burn: CLOCK_MONOTONIC unavailable: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }
    deadline_ms = start_ms + (long long)seconds * 1000;
    cap_bytes = (long long)mib * 1024 * 1024;

    caps_wl_say("io workload started: up to %ld MiB in a private workspace "
                "for %ld s",
                mib, seconds);

    fill_block(block, CAPS_WL_BLOCK, 0);

    while (!caps_wl_stop) {
        long long now = caps_wl_monotonic_ms();
        long long remaining;
        size_t chunk;
        ssize_t n;

        if (now < 0) {
            fprintf(stderr, "caps_io_burn: CLOCK_MONOTONIC failed: %s\n",
                    strerror(errno));
            rc = CAPS_WL_EXIT_SETUP;
            break;
        }
        if (now >= deadline_ms)
            break;

        if (total_written < cap_bytes) {
            remaining = cap_bytes - total_written;
            chunk = (size_t)(remaining < CAPS_WL_BLOCK ? remaining
                                                       : CAPS_WL_BLOCK);
            n = write(fd, block, chunk);
            if (n < 0) {
                if (errno == EINTR)
                    continue;
                fprintf(stderr, "caps_io_burn: write failed: %s\n",
                        strerror(errno));
                rc = CAPS_WL_EXIT_SETUP;
                break;
            }
            total_written += n;
        }

        /* Read the file back so /proc/<pid>/io reports read counters too. */
        n = pread(fd, block, CAPS_WL_BLOCK,
                  (off_t)(total_read % cap_bytes));
        if (n < 0) {
            if (errno == EINTR)
                continue;
            fprintf(stderr, "caps_io_burn: read failed: %s\n",
                    strerror(errno));
            rc = CAPS_WL_EXIT_SETUP;
            break;
        }
        if (n > 0)
            total_read += n;

        caps_wl_sleep_ms(20);
    }

    if (rc == 0 && !caps_wl_stop && fsync(fd) != 0 && errno != EINVAL) {
        fprintf(stderr, "caps_io_burn: fsync failed: %s\n", strerror(errno));
        rc = CAPS_WL_EXIT_SETUP;
    }

    elapsed_ms = caps_wl_monotonic_ms();
    if (close(fd) != 0 && rc == 0) {
        fprintf(stderr, "caps_io_burn: close failed: %s\n", strerror(errno));
        rc = CAPS_WL_EXIT_SETUP;
    }
    free(block);

    if (caps_wl_stop)
        caps_wl_say("io workload stopped by signal after %.3f s",
                    elapsed_ms < 0 ? 0.0
                                   : (double)(elapsed_ms - start_ms) / 1000.0);
    else
        caps_wl_say("io workload completed: %.3f s elapsed",
                    elapsed_ms < 0 ? 0.0
                                   : (double)(elapsed_ms - start_ms) / 1000.0);
    caps_wl_say("workspace bytes written: %lld, bytes read back: %lld",
                total_written, total_read);

    remove_workspace(dir_template);

    if (rc == 0 && caps_wl_stop)
        rc = CAPS_WL_EXIT_STOPPED;
    return rc;
}
