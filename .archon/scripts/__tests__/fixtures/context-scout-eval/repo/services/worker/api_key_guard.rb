# frozen_string_literal: true

require 'openssl'

# Guards the worker's internal HTTP endpoints. A job submitter must present the
# shared key for its tenant; anything else is turned away before a job is queued.
class ApiKeyGuard
  HEADER = 'HTTP_X_WORKER_KEY'

  def initialize(app, key_store)
    @app = app
    @key_store = key_store
  end

  def call(env)
    presented = env[HEADER].to_s
    tenant = env['HTTP_X_TENANT'].to_s
    expected = @key_store.fetch(tenant, nil)

    return reject('unknown tenant') if expected.nil?
    return reject('missing key') if presented.empty?
    return reject('wrong key') unless same?(presented, expected)

    @app.call(env)
  end

  private

  def same?(left, right)
    left.bytesize == right.bytesize && OpenSSL.fixed_length_secure_compare(left, right)
  end

  def reject(reason)
    [401, { 'content-type' => 'application/json' }, [%({"error":"#{reason}"})]]
  end
end
