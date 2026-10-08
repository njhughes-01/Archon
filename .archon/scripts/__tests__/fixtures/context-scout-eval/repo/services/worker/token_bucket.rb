# frozen_string_literal: true

# Smooths how fast the worker pulls jobs. Each pull spends one token; tokens
# refill at a steady rate up to the bucket's capacity.
class TokenBucket
  def initialize(capacity:, refill_per_second:, clock: -> { Process.clock_gettime(Process::CLOCK_MONOTONIC) })
    @capacity = capacity.to_f
    @refill_per_second = refill_per_second.to_f
    @clock = clock
    @tokens = @capacity
    @refilled_at = @clock.call
  end

  def take
    refill
    return false if @tokens < 1.0

    @tokens -= 1.0
    true
  end

  private

  def refill
    now = @clock.call
    @tokens = [@capacity, @tokens + (now - @refilled_at) * @refill_per_second].min
    @refilled_at = now
  end
end
