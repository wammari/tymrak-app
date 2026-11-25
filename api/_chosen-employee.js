// Which business (employee record) an employee request is about, for people who work for
// more than one business. The employee pages send the chosen record's id in this header.
// The database only accepts it when that record belongs to the signed-in person.
export const CHOSEN_EMPLOYEE_HEADER = "x-tymrak-employee-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// undefined: none chosen. null: an invalid value was sent. Otherwise the id.
export function chosenEmployeeId(req) {
  const raw = req.headers?.[CHOSEN_EMPLOYEE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return undefined;
  return typeof value === "string" && UUID.test(value) ? value : null;
}

export const CHOOSE_BUSINESS_MESSAGE = "You work for more than one business. Choose which business you're working for, then try again.";
