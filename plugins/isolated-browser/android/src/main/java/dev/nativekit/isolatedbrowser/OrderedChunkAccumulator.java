package dev.nativekit.isolatedbrowser;

import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

/** Main-thread-confined bounded ordered reassembly for authenticated Messenger envelopes. */
final class OrderedChunkAccumulator {
    private static final Pattern TRANSFER_ID = Pattern.compile("[A-Za-z0-9_-]{1,80}");

    static final class Result {
        final boolean complete;
        final String value;

        private Result(boolean complete, String value) {
            this.complete = complete;
            this.value = value;
        }

        static Result pending() { return new Result(false, null); }
        static Result complete(String value) { return new Result(true, value); }
    }

    private static final class Transfer {
        final String origin;
        final int count;
        final long createdAt;
        final StringBuilder value = new StringBuilder();
        int nextIndex;

        Transfer(String origin, int count, long createdAt) {
            this.origin = origin;
            this.count = count;
            this.createdAt = createdAt;
        }
    }

    private final int maxChunkChars;
    private final int maxMessageChars;
    private final int maxChunks;
    private final int maxActive;
    private final int maxOriginChars;
    private final long timeoutMs;
    private final Map<String, Transfer> transfers = new HashMap<>();

    OrderedChunkAccumulator(int maxChunkChars, int maxMessageChars, int maxChunks, int maxActive, int maxOriginChars, long timeoutMs) {
        if (maxChunkChars < 1 || maxMessageChars < maxChunkChars || maxChunks < 1 || maxActive < 1 || maxOriginChars < 0 || timeoutMs < 1) {
            throw new IllegalArgumentException("Invalid chunk accumulator bounds");
        }
        this.maxChunkChars = maxChunkChars;
        this.maxMessageChars = maxMessageChars;
        this.maxChunks = maxChunks;
        this.maxActive = maxActive;
        this.maxOriginChars = maxOriginChars;
        this.timeoutMs = timeoutMs;
    }

    Result accept(String transferId, String origin, int index, int count, String chunk, long nowMs) {
        pruneExpired(nowMs);
        String safeOrigin = origin == null ? "" : origin;
        if (transferId == null || !TRANSFER_ID.matcher(transferId).matches() || safeOrigin.length() > maxOriginChars || chunk == null
            || chunk.length() > maxChunkChars || count < 1 || count > maxChunks || index < 0 || index >= count) {
            forget(transferId);
            throw new IllegalArgumentException("invalid chunk envelope");
        }
        Transfer transfer = transfers.get(transferId);
        if (transfer == null) {
            if (index != 0 || transfers.size() >= maxActive) throw new IllegalArgumentException("unexpected or excessive transfer");
            transfer = new Transfer(safeOrigin, count, nowMs);
            transfers.put(transferId, transfer);
        }
        if (transfer.count != count || transfer.nextIndex != index || !transfer.origin.equals(safeOrigin)
            || transfer.value.length() + chunk.length() > maxMessageChars) {
            transfers.remove(transferId);
            throw new IllegalArgumentException("inconsistent chunk sequence");
        }
        transfer.value.append(chunk);
        transfer.nextIndex += 1;
        if (transfer.nextIndex != transfer.count) return Result.pending();
        transfers.remove(transferId);
        return Result.complete(transfer.value.toString());
    }

    void forget(String transferId) { if (transferId != null) transfers.remove(transferId); }
    void clear() { transfers.clear(); }
    int activeCount() { return transfers.size(); }

    int pruneExpired(long nowMs) {
        long threshold = nowMs - timeoutMs;
        int before = transfers.size();
        transfers.entrySet().removeIf(entry -> entry.getValue().createdAt < threshold);
        return before - transfers.size();
    }
}
