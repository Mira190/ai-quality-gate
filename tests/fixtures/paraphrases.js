'use strict';
// A rule as a document would state it, and the name a programmer would give the test that proves it: pairs from
// unrelated domains, written to differ in wording the way real ones do. None is taken from a repository the gate has
// been run on. The lexicon is measured against these, so a change to it has to help in general or it shows here.
//
// `orphans` are rules whose test is not in the pool: nothing should be offered as a candidate for them.
module.exports = {
  pairs: [
    // commerce
    ['A coupon can be redeemed only one time per customer.', 'rejects a second redemption of the same coupon by a customer'],
    ['The order total never goes below zero after discounts.', 'clamps the total at 0 when discounts exceed the subtotal'],
    ['Items that are out of stock cannot be added to the cart.', 'refuses to add a product with no inventory'],
    ['A refund must not exceed the amount that was paid.', 'caps a refund at the original payment'],
    ['Prices are shown with two decimal places.', 'formats a price to 2 decimals'],
    // accounts and access
    ['An account is locked after five failed sign-in attempts.', 'locks the account on the 5th wrong password'],
    ['Only administrators may delete other users.', 'returns 403 when a non-admin removes a user'],
    ['A password reset link stops working after one hour.', 'expires the reset token after 60 minutes'],
    ['Passwords are never written to the logs.', 'redacts the password in log output'],
    ['A signed-out user is redirected to the login page.', 'sends an anonymous visitor to /login'],
    // messaging and delivery
    ['Each webhook is delivered at least once, even if the receiver is down.', 'retries a webhook until the endpoint answers'],
    ['A notification is not sent twice for the same event.', 'deduplicates notifications by event id'],
    ['Messages are processed in the order they arrived.', 'handles queued messages first in, first out'],
    ['Nothing in the queue is lost when the worker restarts.', 'keeps pending jobs across a worker crash'],
    ['An email with an invalid address is rejected.', 'returns a validation error for a malformed email'],
    // files and data
    ['Uploads larger than 10 MB are refused.', 'rejects a file over the size limit'],
    ['Deleting a folder removes everything inside it.', 'purges the children when a directory is deleted'],
    ['An export contains every row, including archived ones.', 'includes archived records in the CSV download'],
    ['Saving twice with the same content creates no new version.', 'does not add a revision when nothing changed'],
    ['Data is encrypted before it is written to disk.', 'stores only ciphertext on disk'],
    // scheduling and time
    ['A reminder fires 15 minutes before the meeting starts.', 'schedules the alert a quarter of an hour ahead of the event'],
    ['Two bookings cannot overlap in the same room.', 'refuses a reservation that collides with an existing one'],
    ['A session ends after 30 minutes without activity.', 'times out an idle session after half an hour'],
    ['Recurring tasks skip public holidays.', 'does not schedule a repeat on a holiday'],
    // concurrency and resilience
    ['Two requests that update the same record at once must not overwrite each other.', 'detects a concurrent edit and returns a conflict'],
    ['The service keeps answering when the cache is unavailable.', 'falls back to the database when redis is down'],
    ['A failed payment is tried again up to three times.', 'retries a declined charge 3 times and then gives up'],
    ['Configuration changes take effect without a restart.', 'reloads the config while running'],
    // interface
    ['The submit button is disabled until the form is valid.', 'keeps Save greyed out while a required field is empty'],
    ['Search results are sorted by relevance by default.', 'orders hits by score when no sort is given'],
    ['An empty list shows a message instead of a blank page.', 'renders a placeholder when there are no items'],
    ['Long names are cut off with an ellipsis.', 'truncates a title that does not fit'],
  ],
  orphans: [
    'The thumbnail generator supports animated images.',
    'Audit entries are retained for seven years.',
    'The map tiles are cached per zoom level.',
    'Invoices are numbered consecutively within a fiscal year.',
    'The compiler reports the column of a syntax error.',
    'A playlist can be shared with a public link.',
  ],
};
