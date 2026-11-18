import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractIntake, findGrade, findNames, findTargetDate } from '../../src/core/ai/mock/intake.js';
import { intakeOutput } from '../../src/core/ai/agents/intake.js';

// The mock intake agent on realistic enquiries (English, Hinglish, WhatsApp style). Every answer
// must also pass the agent's output schema, as a real model's would have to.

const now = new Date('2026-11-06T10:00:00Z');
const extract = (message, extra = {}) => {
  const out = extractIntake({ message, ...extra }, { now });
  intakeOutput.parse(out);
  return out;
};

test('an English enquiry from a mother: names, grade, exam, date, city, phone and intent', () => {
  const out = extract('Hi, I am Priya Sharma. My son Aarav is in class 10 and we want to prepare for the SAT in October 2027. We live in Pune. Please call me on 98765 43210.');
  assert.equal(out.parentName, 'Priya Sharma');
  assert.equal(out.studentName, 'Aarav');
  assert.equal(out.enquirer, 'parent');
  assert.equal(out.grade, '10');
  assert.equal(out.exam, 'SAT');
  assert.equal(out.targetDate, '2027-10');
  assert.equal(out.city, 'Pune');
  assert.equal(out.timeZone, 'Asia/Kolkata');
  assert.equal(out.phone, '+919876543210');
  assert.equal(out.intent, 'callback');
  assert.equal(out.language, 'en');
  assert.ok(out.confidence >= 0.9);
  assert.deepEqual(out.missing, []);
});

test('a Hinglish WhatsApp message with a signature', () => {
  const out = extract('Namaste sir, mera beta Rohan 11th mein hai, JEE Mains ki taiyari karni hai. Hum Jaipur se hain. Fees kitni hai? - Sunita Verma');
  assert.equal(out.parentName, 'Sunita Verma');
  assert.equal(out.studentName, 'Rohan');
  assert.equal(out.grade, '11');
  assert.equal(out.exam, 'JEE Main');
  assert.equal(out.city, 'Jaipur');
  assert.equal(out.intent, 'fee_enquiry');
  assert.equal(out.language, 'hi');
  assert.equal(out.hinglish, true);
  assert.match(out.summary, /^Fee enquiry from parent Sunita Verma: JEE Main for Rohan \(class 11\), Jaipur\.$/);
});

test('a father in Dubai: relation, board, email, time zone from the city', () => {
  const out = extract(
    "Hello, my daughter Ananya Iyer studies in grade 12 (CBSE). She wants to give SAT in Dec 2026. Can we book a demo class this weekend? I'm her father, Ramesh. Email: ramesh.iyer@example.com. We are based in Dubai.",
  );
  assert.equal(out.relation, 'father');
  assert.equal(out.parentName, 'Ramesh');
  assert.equal(out.studentName, 'Ananya Iyer');
  assert.equal(out.board, 'CBSE');
  assert.equal(out.targetDate, '2026-12');
  assert.equal(out.intent, 'book_demo');
  assert.equal(out.email, 'ramesh.iyer@example.com');
  assert.equal(out.city, 'Dubai');
  assert.equal(out.timeZone, 'Asia/Dubai');
});

test('a student writing in lower case for themselves', () => {
  const out = extract('hi im kabir, class 9 student from delhi. want to join olympiad maths batch. whats the fee');
  assert.equal(out.enquirer, 'student');
  assert.equal(out.studentName, 'Kabir');
  assert.equal(out.parentName, null);
  assert.equal(out.grade, '9');
  assert.equal(out.exam, 'Olympiad');
  assert.equal(out.city, 'Delhi');
  assert.equal(out.intent, 'fee_enquiry');
  assert.deepEqual(out.intents.slice(0, 2), ['fee_enquiry', 'admission']);
});

test('Hinglish "beti ka naam", a year-only target and a demo request', () => {
  const out = extract('Meri beti ka naam Kavya hai, 10th class me hai. NEET 2028 ke liye coaching chahiye. Demo class kab hai? Lucknow');
  assert.equal(out.studentName, 'Kavya');
  assert.equal(out.grade, '10');
  assert.equal(out.exam, 'NEET');
  assert.equal(out.targetDate, '2028');
  assert.equal(out.intent, 'book_demo');
  assert.equal(out.city, 'Lucknow');
  assert.ok(out.missing.includes('contactName'));
});

test('honorifics are dropped and "mother of" names the student', () => {
  const out = extract("Good evening. I'm Dr. Meera Nair, mother of Aditya (Grade 8, ICSE) - looking for SAT foundation. Based in Bengaluru. WhatsApp +91 99887 76655.");
  assert.equal(out.parentName, 'Meera Nair');
  assert.equal(out.relation, 'mother');
  assert.equal(out.studentName, 'Aditya');
  assert.equal(out.grade, '8');
  assert.equal(out.board, 'ICSE');
  assert.equal(out.city, 'Bengaluru');
  assert.equal(out.phone, '+919988776655');
});

test('"main ... bol raha hu" and JEE Advanced, with the sender number for the time zone', () => {
  const out = extract('Main Rakesh bol raha hu, mere bhatija ko JEE advanced ke liye 1:1 mentorship chahiye. Call karo', { senderPhone: '+971501234567' });
  assert.equal(out.parentName, 'Rakesh');
  assert.equal(out.relation, 'guardian');
  assert.equal(out.exam, 'JEE Advanced');
  assert.deepEqual(out.exams, ['JEE Advanced']);
  assert.equal(out.intent, 'callback');
  assert.equal(out.timeZone, 'Asia/Dubai');
});

test('a refund request is the refund intent; an empty greeting has low confidence', () => {
  assert.equal(extract('I paid 45000 for the SAT batch but classes were cancelled. I want my money back.').intent, 'refund');
  const hello = extract('hello');
  assert.equal(hello.intent, 'other');
  assert.ok(hello.confidence < 0.4);
});

test('a B2B enquiry is marked b2b', () => {
  assert.equal(extract('We run a coaching institute with 3 branches and need an online test platform. Please share a demo.').audience, 'b2b');
});

test('grades, names and dates edge cases', () => {
  assert.equal(findGrade('she is in class XII'), '12');
  assert.equal(findGrade('dropper preparing for NEET'), 'dropper');
  assert.equal(findGrade('the exam is on 15th March'), null);
  assert.equal(findNames('I am interested in the SAT batch').contactName, null);
  assert.equal(findNames('I am from Pune').contactName, null);
  assert.equal(findTargetDate('exam on 5 May 2027', now), '2027-05-05');
  assert.equal(findTargetDate('target March attempt', now), '2027-03');
  assert.equal(findTargetDate('in December', now), '2026-12');
  assert.equal(findTargetDate('next year', now), '2027');
});
