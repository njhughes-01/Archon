# frozen_string_literal: true

require 'csv'

# Writes one customer's invoices to a CSV file, a batch of rows at a time.
class ExportJob
  HEADERS = %w[number issued_on total_cents status].freeze

  def initialize(invoices, batch_rows: 5_000)
    @invoices = invoices
    @batch_rows = batch_rows
  end

  def write(io)
    io << CSV.generate_line(HEADERS)
    @invoices.each_slice(@batch_rows) do |batch|
      batch.each do |invoice|
        io << CSV.generate_line([invoice.number, invoice.issued_on.iso8601, invoice.total_cents, invoice.status])
      end
      io.flush
    end
  end
end
