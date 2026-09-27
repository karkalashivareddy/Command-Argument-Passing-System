/*
 * caps_mixed_burn — controlled combined CPU + memory + I/O workload.
 *
 *   caps_mixed_burn <seconds> <mib> <io-mib>
 *
 * Purpose: demonstrate that the observatory can correlate several resource
 * signals for one process on one shared timeline.  The three phases are
 * interleaved inside a single process so every /proc signal in one sample
 * describes the same PID at the same instant.
 *
 * Safety envelope (identical ceilings to the single-purpose workloads):
 *   - duration  1..30 s
 *   - resident  1..256 MiB (mmap + explicit page touches)
 *   - I/O       1..64 MiB in a private mkdtemp workspace, removed on exit
 *   - no shell, no network, no child processes, no unbounded output
 *
 * This is a controlled laboratory workload.
 */

#include <dirent.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include "workload_common.h"

volatile sig_atomic_t caps_wl_stop = 0;

#define CAPS_WL_BLOCK (32 * 1024)
#define CAPS_WL_CPU_BATCH 40000

static void fill_block(unsigned char *buf, size_t len)
{
    for (size_t i = 0; i < len; i++)
        buf[i] = (unsigned char)(((i + 1u) * 17u) & 0xffu);
}

static uint64_t mix(uint64_t x)
{
    x ^= x >> 30;
    x *= 0xbf58476d1ce4e5b9ULL;
    x ^= x >> 27;
    x *= 0x94d049bb133111ebULL;
    x ^= x >> 31;
    return x;
}

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
    long mem_mib = 64;
    long io_mib = 8;
    long long start_ms, deadline_ms, elapsed_ms;
    long long io_cap, total_written = 0, total_read = 0;
    size_t bytes, page;
    unsigned char *region = MAP_FAILED;
    unsigned char *block = NULL;
    uint64_t state = 0x9e3779b97f4a7c15ULL;
    const char *tmp;
    char dir_template[4096];
    char file_path[4200];
    int fd = -1;
    int rounds = 0;
    int rc = 0;

    if (argc > 1 && caps_wl_parse_bounded(argv[1], CAPS_WL_MIN_DURATION_S,
                                          CAPS_WL_MAX_DURATION_S, &seconds) != 0) {
        caps_wl_usage(argv[0], "<seconds> <mib> <io-mib>",
                      "duration must be an integer 1..30 (controlled workload)");
        return CAPS_WL_EXIT_USAGE;
    }
    if (argc > 2 && caps_wl_parse_bounded(argv[2], 1, CAPS_WL_MAX_MEMORY_MIB,
                                          &mem_mib) != 0) {
        caps_wl_usage(argv[0], "<seconds> <mib> <io-mib>",
                      "resident target must be an integer 1..256 MiB");
        return CAPS_WL_EXIT_USAGE;
    }
    if (argc > 3 && caps_wl_parse_bounded(argv[3], 1, CAPS_WL_MAX_IO_MIB,
                                          &io_mib) != 0) {
        caps_wl_usage(argv[0], "<seconds> <mib> <io-mib>",
                      "workspace size must be an integer 1..64 MiB");
        return CAPS_WL_EXIT_USAGE;
    }
    if (argc > 4) {
        caps_wl_usage(argv[0], "<seconds> <mib> <io-mib>",
                      "this workload accepts at most three arguments");
        return CAPS_WL_EXIT_USAGE;
    }

    if (caps_wl_install_stop_handlers() != 0) {
        fprintf(stderr, "caps_mixed_burn: cannot install stop handlers: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }

    page = (size_t)sysconf(_SC_PAGESIZE);
    if (page == 0 || page == (size_t)-1) {
        fprintf(stderr, "caps_mixed_burn: cannot determine page size: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }

    bytes = (size_t)mem_mib * 1024u * 1024u;
    if (bytes % page != 0)
        bytes += page - (bytes % page);
    region = mmap(NULL, bytes, PROT_READ | PROT_WRITE,
                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (region == MAP_FAILED) {
        fprintf(stderr, "caps_mixed_burn: mmap of %ld MiB failed: %s\n",
                mem_mib, strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }

    block = malloc(CAPS_WL_BLOCK);
    if (block == NULL) {
        (void)munmap(region, bytes);
        fprintf(stderr, "caps_mixed_burn: out of memory\n");
        return CAPS_WL_EXIT_SETUP;
    }
    fill_block(block, CAPS_WL_BLOCK);

    tmp = getenv("TMPDIR");
    if (tmp == NULL || tmp[0] == '\0')
        tmp = "/tmp";
    if (snprintf(dir_template, sizeof dir_template, "%s/caps-mixed-XXXXXX",
                 tmp) >= (int)sizeof dir_template) {
        (void)munmap(region, bytes);
        free(block);
        fprintf(stderr, "caps_mixed_burn: TMPDIR path is too long\n");
        return CAPS_WL_EXIT_SETUP;
    }
    if (mkdtemp(dir_template) == NULL) {
        (void)munmap(region, bytes);
        free(block);
        fprintf(stderr, "caps_mixed_burn: cannot create workspace: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }
    if (snprintf(file_path, sizeof file_path, "%s/mixed.dat", dir_template) >=
        (int)sizeof file_path) {
        (void)munmap(region, bytes);
        free(block);
        remove_workspace(dir_template);
        fprintf(stderr, "caps_mixed_burn: workspace path is too long\n");
        return CAPS_WL_EXIT_SETUP;
    }
    fd = open(file_path, O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        (void)munmap(region, bytes);
        free(block);
        remove_workspace(dir_template);
        fprintf(stderr, "caps_mixed_burn: cannot open workspace file: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }

    start_ms = caps_wl_monotonic_ms();
    if (start_ms < 0) {
        (void)close(fd);
        free(block);
        (void)munmap(region, bytes);
        remove_workspace(dir_template);
        fprintf(stderr, "caps_mixed_burn: CLOCK_MONOTONIC unavailable: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }
    deadline_ms = start_ms + (long long)seconds * 1000;
    io_cap = (long long)io_mib * 1024 * 1024;

    /* Make the whole target resident up front so VmRSS reports the target
     * from the first sample onwards. */
    for (size_t off = 0; off < bytes; off += page)
        region[off] = (unsigned char)(off / page);

    caps_wl_say("mixed workload started: %ld s, %ld MiB resident target, "
                "up to %ld MiB workspace I/O",
                seconds, mem_mib, io_mib);

    while (!caps_wl_stop) {
        long long now = caps_wl_monotonic_ms();

        if (now < 0) {
            fprintf(stderr, "caps_mixed_burn: CLOCK_MONOTONIC failed: %s\n",
                    strerror(errno));
            rc = CAPS_WL_EXIT_SETUP;
            break;
        }
        if (now >= deadline_ms)
            break;

        /* CPU phase */
        for (int i = 0; i < CAPS_WL_CPU_BATCH; i++)
            state = mix(state + (uint64_t)i);

        /* Memory phase: a bounded sweep across the resident mapping */
        for (size_t i = 0; i < 1024; i++) {
            size_t off = (((size_t)rounds * 1024u + i) * page) % bytes;
            region[off] = (unsigned char)(region[off] + 1u);
        }

        /* I/O phase, strictly capped by io_cap */
        if (total_written < io_cap) {
            long long remaining = io_cap - total_written;
            size_t chunk = (size_t)(remaining < CAPS_WL_BLOCK ? remaining
                                                              : CAPS_WL_BLOCK);
            ssize_t n = write(fd, block, chunk);
            if (n < 0) {
                if (errno == EINTR)
                    continue;
                fprintf(stderr, "caps_mixed_burn: write failed: %s\n",
                        strerror(errno));
                rc = CAPS_WL_EXIT_SETUP;
                break;
            }
            total_written += n;

            n = pread(fd, block, CAPS_WL_BLOCK, (off_t)(total_read % io_cap));
            if (n > 0)
                total_read += n;
            else if (n < 0 && errno != EINTR) {
                fprintf(stderr, "caps_mixed_burn: read failed: %s\n",
                        strerror(errno));
                rc = CAPS_WL_EXIT_SETUP;
                break;
            }
        }

        rounds++;
        caps_wl_sleep_ms(25);
    }

    if (rc == 0 && !caps_wl_stop && fsync(fd) != 0 && errno != EINVAL) {
        fprintf(stderr, "caps_mixed_burn: fsync failed: %s\n", strerror(errno));
        rc = CAPS_WL_EXIT_SETUP;
    }
    elapsed_ms = caps_wl_monotonic_ms();
    if (close(fd) != 0 && rc == 0) {
        fprintf(stderr, "caps_mixed_burn: close failed: %s\n", strerror(errno));
        rc = CAPS_WL_EXIT_SETUP;
    }
    if (munmap(region, bytes) != 0) {
        fprintf(stderr, "caps_mixed_burn: munmap failed: %s\n",
                strerror(errno));
        if (rc == 0)
            rc = CAPS_WL_EXIT_SETUP;
    }
    free(block);
    remove_workspace(dir_template);

    if (caps_wl_stop)
        caps_wl_say("mixed workload stopped by signal after %.3f s",
                    elapsed_ms < 0 ? 0.0
                                   : (double)(elapsed_ms - start_ms) / 1000.0);
    else
        caps_wl_say("mixed workload completed: %.3f s elapsed",
                    elapsed_ms < 0 ? 0.0
                                   : (double)(elapsed_ms - start_ms) / 1000.0);
    caps_wl_say("rounds: %d, workspace written: %lld, read back: %lld", rounds,
                total_written, total_read);
    caps_wl_say("checksum: %016llx", (unsigned long long)(state & 0xffffffffULL));

    if (rc == 0 && caps_wl_stop)
        rc = CAPS_WL_EXIT_STOPPED;
    return rc;
}
