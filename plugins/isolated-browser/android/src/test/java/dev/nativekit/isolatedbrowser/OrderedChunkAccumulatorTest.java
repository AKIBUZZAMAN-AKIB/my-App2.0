package dev.nativekit.isolatedbrowser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class OrderedChunkAccumulatorTest {
    private OrderedChunkAccumulator accumulator() {
        return new OrderedChunkAccumulator(4, 8, 3, 2, 12, 100);
    }

    @Test public void reassemblesOnlyACompleteOrderedTransfer() {
        OrderedChunkAccumulator target = accumulator();
        OrderedChunkAccumulator.Result first = target.accept("transfer_1", "https://a", 0, 2, "abcd", 1_000);
        assertFalse(first.complete);
        OrderedChunkAccumulator.Result second = target.accept("transfer_1", "https://a", 1, 2, "ef", 1_001);
        assertTrue(second.complete);
        assertEquals("abcdef", second.value);
        assertEquals(0, target.activeCount());
    }

    @Test public void rejectsOutOfOrderAndOriginChangesAndForgetsTheTransfer() {
        OrderedChunkAccumulator target = accumulator();
        assertThrows(IllegalArgumentException.class, () -> target.accept("late", "https://a", 1, 2, "x", 1_000));
        target.accept("origin", "https://a", 0, 2, "a", 1_000);
        assertThrows(IllegalArgumentException.class, () -> target.accept("origin", "https://b", 1, 2, "b", 1_001));
        assertEquals(0, target.activeCount());
    }

    @Test public void enforcesEnvelopeLogicalAndConcurrentBounds() {
        OrderedChunkAccumulator target = accumulator();
        assertThrows(IllegalArgumentException.class, () -> target.accept("bad id!", "", 0, 1, "x", 1_000));
        assertThrows(IllegalArgumentException.class, () -> target.accept("origin", "origin-is-too-long", 0, 1, "x", 1_000));
        assertThrows(IllegalArgumentException.class, () -> target.accept("chunk", "", 0, 1, "12345", 1_000));
        target.accept("one", "", 0, 3, "1234", 1_000);
        target.accept("two", "", 0, 2, "1", 1_000);
        assertThrows(IllegalArgumentException.class, () -> target.accept("three", "", 0, 1, "1", 1_000));
        target.accept("one", "", 1, 3, "1234", 1_001);
        assertThrows(IllegalArgumentException.class, () -> target.accept("one", "", 2, 3, "x", 1_002));
    }

    @Test public void prunesExpiredPartialTransfersBeforeApplyingActiveLimit() {
        OrderedChunkAccumulator target = accumulator();
        target.accept("old_one", "", 0, 2, "a", 1_000);
        target.accept("old_two", "", 0, 2, "b", 1_000);
        OrderedChunkAccumulator.Result result = target.accept("fresh", "", 0, 1, "ok", 1_101);
        assertTrue(result.complete);
        assertEquals("ok", result.value);
        assertEquals(0, target.activeCount());
    }
}
