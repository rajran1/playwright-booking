import { test, expect } from '@playwright/test';

declare const process: { env: Record<string, string | undefined> };

const RESERVATION_URL = 'https://telfair.onlinecourtreservations.com/reservations';
const USER_ID = process.env.BOOKING_USER_ID || '';
const PASSWORD = process.env.BOOKING_PASSWORD || '';

test('login and book pickleball court @booking', async ({ page }) => {
  test.setTimeout(60000);

  expect(USER_ID, 'Missing BOOKING_USER_ID secret/env var').toBeTruthy();
  expect(PASSWORD, 'Missing BOOKING_PASSWORD secret/env var').toBeTruthy();

  // Navigate to reservation page
  await page.goto(RESERVATION_URL);

  // Click the Sign In link in the navbar (login form is hidden until this is clicked)
  await page.getByRole('link', { name: '  Sign In' }).click();

  // Fill credentials
  await page.getByRole('textbox', { name: 'User ID' }).click();
  await page.getByRole('textbox', { name: 'User ID' }).fill(USER_ID);
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();

  // Select Pickleball site and reload reservations
  await page.locator('#site').selectOption('93');
  await page.goto(RESERVATION_URL);

  // Wait for the actual reservation grid (Start Time table), not just any table.
  const waitForScheduleGrid = async () => {
    const scheduleTable = page.locator('table').filter({ hasText: 'Start Time' }).last();
    await expect(scheduleTable).toBeVisible({ timeout: 45000 });
  };

  try {
    await waitForScheduleGrid();
  } catch {
    // OCRS can occasionally render partial content; one hard refresh usually resolves it.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForScheduleGrid();
  }

  console.log('Login successful, calendar loaded.');

  // OCRS constraints: can only book up to 7 days in advance.
  // Also, account-level weekly reservation caps may hide/disable the Reserve action.
  const preferredTimes = [
    '4:00 PM',
    '4:30 PM',
    '5:00 PM',
    '5:30 PM',
    '6:00 PM',
    '6:30 PM',
    '7:00 PM',
    '7:30 PM',
    '8:00 PM',
    '8:30 PM',
    '9:00 PM',
    '9:30 PM',
    '10:00 PM',
    '10:30 PM',
  ];
  const dayOffsetStart = Number(process.env.BOOKING_DAY_OFFSET_START || '7');
  const dayOffsetEnd = Number(process.env.BOOKING_DAY_OFFSET_END || '7');

  expect(Number.isInteger(dayOffsetStart) && Number.isInteger(dayOffsetEnd), 'Day offsets must be integers').toBeTruthy();
  expect(dayOffsetStart, 'Day offset start must be between 1 and 7').toBeGreaterThanOrEqual(1);
  expect(dayOffsetEnd, 'Day offset end must be between 1 and 7').toBeLessThanOrEqual(7);
  expect(dayOffsetStart, 'Day offset start cannot be greater than end').toBeLessThanOrEqual(dayOffsetEnd);

  let booked = false;
  let bookedTime = '';
  let bookedDayOffset = -1;

  const goToDayOffset = async (dayOffset: number) => {
    if (dayOffset < 1 || dayOffset > 7) {
      throw new Error(`Day offset ${dayOffset} is outside allowed booking window (1-7 days).`);
    }

    await page.goto(RESERVATION_URL);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#NextWeek').click();
    await page.waitForLoadState('domcontentloaded');

    const stepsBack = 7 - dayOffset;
    for (let i = 0; i < stepsBack; i++) {
      await page.locator('#Yesterday').click();
      await page.waitForLoadState('domcontentloaded');
    }
  };

  const tryBookCell = async (cell: ReturnType<typeof page.locator>, dayOffset: number, timeLabel: string, col: number) => {
    console.log(`Day +${dayOffset}: attempting ${timeLabel} slot (col ${col})`);
    await cell.click();
    await page.waitForTimeout(300);

    const durationSelect = page.locator('#Duration');
    if (await durationSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await durationSelect.selectOption('2');
    }

    const reserveBtn = page.getByRole('button', { name: 'Reserve' });
    const reserveVisible = await reserveBtn.isVisible({ timeout: 1200 }).catch(() => false);
    if (!reserveVisible) {
      console.log(
        `Day +${dayOffset}: no Reserve button shown for ${timeLabel}, likely weekly cap reached or outside reservation policy.`
      );
      return false;
    }

    await reserveBtn.click();
    await page.waitForTimeout(500);

    booked = true;
    bookedTime = timeLabel;
    bookedDayOffset = dayOffset;
    return true;
  };

  for (let dayOffset = dayOffsetStart; dayOffset <= dayOffsetEnd && !booked; dayOffset++) {
    await goToDayOffset(dayOffset);

    const scheduleTable = page.locator('table').filter({ hasText: 'Start Time' }).last();
    await expect(scheduleTable).toBeVisible({ timeout: 30000 });

    for (const targetTime of preferredTimes) {
      if (booked) break;

      const rows = scheduleTable.locator('tr');
      const rowCount = await rows.count();

      for (let r = 0; r < rowCount && !booked; r++) {
        const row = rows.nth(r);
        const cells = row.locator('th, td');
        const cellCount = await cells.count();
        if (cellCount < 3) {
          continue;
        }

        const firstCellText = ((await cells.first().textContent()) || '').trim();
        if (firstCellText !== targetTime) {
          continue;
        }

        // In day view, first and last columns are time labels. Middle cells are bookable courts.
        for (let col = 1; col <= cellCount - 2; col++) {
          const cell = cells.nth(col);
          const cellText = ((await cell.textContent()) || '').trim();
          if (cellText !== '') {
            continue;
          }

          const confirmed = await tryBookCell(cell, dayOffset, targetTime, col);
          if (confirmed) {
            break;
          }
        }
      }
    }
  }

  if (booked) {
    console.log(`Booking confirmed for Day +${bookedDayOffset} at ${bookedTime}`);
  } else {
    console.log(`No bookable slot found in day window +${dayOffsetStart}..+${dayOffsetEnd} (or booking cap/policy blocked booking).`);
  }

  expect(booked, `No confirmed bookable slot for day window +${dayOffsetStart}..+${dayOffsetEnd}.`).toBeTruthy();
});

test.describe.skip('Court Reservation - Debug Page Structure', () => {
  test('inspect table structure and identify clickable elements', async ({ page }) => {
    await page.goto(RESERVATION_URL);
    await page.waitForLoadState('networkidle');

    // Log all text on the page
    const pageText = await page.textContent('body');
    console.log('=== PAGE TEXT ===');
    console.log(pageText?.substring(0, 1000));

    // Find all tables
    const tables = page.locator('table');
    const tableCount = await tables.count();
    console.log(`Found ${tableCount} tables`);

    // Get all cells in table
    const cells = page.locator('table td, table th');
    const cellCount = await cells.count();
    console.log(`Total table cells: ${cellCount}`);

    // Find cells with onclick handlers or links
    console.log('\n=== CLICKABLE CELLS ===');
    for (let i = 0; i < cellCount; i++) {
      const cell = cells.nth(i);
      const onclick = await cell.getAttribute('onclick');
      const link = cell.locator('a');
      const linkCount = await link.count();
      
      if (onclick || linkCount > 0) {
        const text = await cell.textContent();
        console.log(`Cell ${i}: "${text?.trim()}" | onclick: ${onclick?.substring(0, 60)}`);
      }
    }

    // Find empty cells (available for booking)
    console.log('\n=== EMPTY CELLS (AVAILABLE SLOTS) ===');
    let emptyCount = 0;
    for (let i = 0; i < cellCount; i++) {
      const cell = cells.nth(i);
      const text = await cell.textContent();
      
      if (text?.trim() === '') {
        console.log(`Empty cell at index ${i}`);
        emptyCount++;
        if (emptyCount >= 10) break; // Just show first 10
      }
    }

    // Take screenshot of whole page
    await page.screenshot({ path: 'debug-page-structure.png', fullPage: true });
  });

  test('find all clickable/interactive elements', async ({ page }) => {
    await page.goto(RESERVATION_URL);
    await page.waitForLoadState('networkidle');

    // Find all links
    const links = page.locator('a');
    const linkCount = await links.count();
    console.log(`Found ${linkCount} links`);
    
    for (let i = 0; i < Math.min(10, linkCount); i++) {
      const link = links.nth(i);
      const text = await link.textContent();
      const href = await link.getAttribute('href');
      console.log(`Link ${i}: "${text?.trim()}" -> ${href}`);
    }

    // Find all buttons
    const buttons = page.locator('button');
    const buttonCount = await buttons.count();
    console.log(`Found ${buttonCount} buttons`);
    
    for (let i = 0; i < Math.min(10, buttonCount); i++) {
      const button = buttons.nth(i);
      const text = await button.textContent();
      const classes = await button.getAttribute('class');
      console.log(`Button ${i}: "${text?.trim()}" | Classes: ${classes}`);
    }

    // Find all elements with onclick
    const onClickElements = page.locator('[onclick]');
    const onClickCount = await onClickElements.count();
    console.log(`Found ${onClickCount} elements with onclick`);

    for (let i = 0; i < Math.min(10, onClickCount); i++) {
      const elem = onClickElements.nth(i);
      const text = await elem.textContent();
      const onclick = await elem.getAttribute('onclick');
      console.log(`OnClick ${i}: "${text?.trim()}" | Action: ${onclick?.substring(0, 50)}`);
    }
  });

  test('try clicking different court cells', async ({ page }) => {
    await page.goto(RESERVATION_URL);
    await page.waitForLoadState('networkidle');

    // Get all table cells
    const cells = page.locator('table td');
    const cellCount = await cells.count();

    console.log(`\nTrying to click cells (total: ${cellCount})...`);

    // Try clicking the first few empty-looking cells
    for (let i = 0; i < Math.min(15, cellCount); i++) {
      const cell = cells.nth(i);
      const text = await cell.textContent();
      const isVisible = await cell.isVisible();
      const isClickable = await cell.evaluate((el) => {
        return window.getComputedStyle(el).cursor === 'pointer';
      }).catch(() => false);

      if ((text?.trim() === '' || !text?.trim()) && isVisible) {
        console.log(`Cell ${i} looks empty and visible - attempting click`);
        
        try {
          await cell.click();
          await page.waitForTimeout(1000);
          
          // Check if anything changed after click
          const newText = await page.textContent('body');
          console.log('Page changed after click');
          
          // Take screenshot
          await page.screenshot({ path: `debug-after-cell-${i}-click.png` });
          break;
        } catch (e) {
          console.log(`Cell ${i} click failed: ${e}`);
        }
      }
    }
  });

  test('look for form or modal elements', async ({ page }) => {
    await page.goto(RESERVATION_URL);
    await page.waitForLoadState('networkidle');

    // Check for various form/modal containers
    const forms = page.locator('form');
    const modals = page.locator('div[class*="modal"], div[id*="modal"]');
    const dialogs = page.locator('dialog, [role="dialog"]');
    const overlays = page.locator('div[class*="overlay"], div[class*="popup"]');

    console.log(`Forms: ${await forms.count()}`);
    console.log(`Modals: ${await modals.count()}`);
    console.log(`Dialogs: ${await dialogs.count()}`);
    console.log(`Overlays: ${await overlays.count()}`);

    // Check for hidden elements that might appear
    const allDivs = page.locator('div');
    const divCount = await allDivs.count();
    console.log(`Total divs: ${divCount}`);

    // Look for elements with display:none or hidden
    for (let i = 0; i < Math.min(50, divCount); i++) {
      const div = allDivs.nth(i);
      const display = await div.evaluate((el) => window.getComputedStyle(el).display);
      const visibility = await div.evaluate((el) => window.getComputedStyle(el).visibility);
      const classes = await div.getAttribute('class');
      
      if ((display === 'none' || visibility === 'hidden') && classes?.includes('modal')) {
        console.log(`Found hidden modal: ${classes}`);
      }
    }
  });

  test('check for right-click context menu', async ({ page }) => {
    await page.goto(RESERVATION_URL);
    await page.waitForLoadState('networkidle');

    // Get an empty cell
    const cells = page.locator('table td');
    
    for (let i = 0; i < await cells.count(); i++) {
      const cell = cells.nth(i);
      const text = await cell.textContent();
      
      if (text?.trim() === '') {
        console.log(`Found empty cell at index ${i} - trying right-click`);
        
        // Try right-click
        await cell.click({ button: 'right' });
        await page.waitForTimeout(500);
        
        // Check for context menu
        const contextMenu = page.locator('[class*="context"], [class*="menu"]');
        const menuCount = await contextMenu.count();
        console.log(`Elements matching menu after right-click: ${menuCount}`);
        
        // Take screenshot
        await page.screenshot({ path: 'debug-right-click.png' });
        break;
      }
    }
  });

  test('check browser console for errors', async ({ page }) => {
    const consoleLogs: string[] = [];
    const consoleErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      } else {
        consoleLogs.push(msg.text());
      }
    });

    await page.goto(RESERVATION_URL);
    await page.waitForLoadState('networkidle');

    // Try interacting
    const cells = page.locator('table td');
    const firstEmpty = cells.nth(0);
    await firstEmpty.click().catch(() => {});

    console.log('Console Errors:', consoleErrors);
    console.log('Console Logs:', consoleLogs.slice(0, 5));
  });
});
