export interface Address {
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

const POSTAL_PATTERNS: Record<string, RegExp> = {
  US: /^\d{5}(-\d{4})?$/,
  CA: /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/,
  GB: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/,
};

/** Field-by-field messages for the shipping form; an empty object means valid. */
export function validateAddress(address: Address): Partial<Record<keyof Address, string>> {
  const errors: Partial<Record<keyof Address, string>> = {};
  if (address.street.trim().length < 3) errors.street = 'Enter a street address';
  if (address.city.trim() === '') errors.city = 'Enter a city';
  const pattern = POSTAL_PATTERNS[address.country];
  if (!pattern) errors.country = 'We do not ship to this country yet';
  else if (!pattern.test(address.postalCode.toUpperCase())) {
    errors.postalCode = 'That postal code does not look right';
  }
  return errors;
}
