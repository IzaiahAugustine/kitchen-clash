// Unit tests for scoring and the referee. Usage: npx tsx tools/sim/rules-test.ts
import { Referee, inServiceBox } from '../../src/rules/referee';
import { DEFAULT_SCORING, Score, type Team } from '../../src/rules/scoring';
import { ServeRotation, serveSetup } from '../../src/rules/serve';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

// --- side-out singles
{
  const s = new Score(DEFAULT_SCORING, 0);
  check('starts 0-0, serve from right', [s.call(), s.serveFromRight()], ['0-0', true]);
  s.rallyWonBy(0);
  check('server scores → 1-0, now from left', [s.call(), s.serveFromRight()], ['1-0', false]);
  const o = s.rallyWonBy(1);
  check('receiver wins → side out, no point', [o.sideOut, o.pointTo, s.servingTeam, s.call()], [true, null, 1, '0-1']);
  for (let i = 0; i < 10; i++) s.rallyWonBy(1);
  check('far team reaches 10-1', s.call(), '10-1');
  check('game point for serving team', s.gamePointFor(), 1);
  s.rallyWonBy(1);
  check('11-1 wins', s.winner(), 1);
}
// --- win by 2
{
  const s = new Score(DEFAULT_SCORING, 0);
  s.points[0] = 10;
  s.points[1] = 10;
  s.rallyWonBy(0);
  check('11-10 is not a win', s.winner(), null);
  s.rallyWonBy(0);
  check('12-10 wins', s.winner(), 0);
}
// --- rally scoring
{
  const s = new Score({ ...DEFAULT_SCORING, mode: 'rally' }, 0);
  const o = s.rallyWonBy(1);
  check('rally: receiver scores and takes serve', [o.pointTo, o.sideOut, s.servingTeam, s.call()], [1, true, 1, '1-0']);
}
// --- doubles side-out call and second server
{
  const s = new Score({ ...DEFAULT_SCORING, teamSize: 2 }, 0);
  check('doubles starts 0-0-2', s.call(), '0-0-2');
  s.rallyWonBy(1);
  check('first fault of the game is a side out → 0-0-1', [s.servingTeam, s.call()], [1, '0-0-1']);
  s.rallyWonBy(0);
  check('then to the second server → 0-0-2', [s.servingTeam, s.call()], [1, '0-0-2']);
}
// --- service boxes
{
  const near = serveSetup(1, true); // near server, even score: from the right (+x)
  check('near server from right stands at +x behind baseline', [near.serverPos.x > 0, near.serverPos.z > 22], [true, true]);
  check('targets the far box on the -x side', near.boxSide, -1);
  check('deep crosscourt is in', inServiceBox(-5, -15, -1, -1), true);
  check('kitchen line is short', inServiceBox(-5, -6.95, -1, -1), false);
  check('centerline counts as in', inServiceBox(0, -15, -1, -1), true);
  check('wrong box is out', inServiceBox(5, -15, -1, -1), false);
  check('far server from right stands at -x', serveSetup(-1, true).serverPos.x < 0, true);
}
// --- referee
{
  const r = new Referee();
  r.startRally(1, -1);
  check('short serve called', r.onBounce(-5, -5)?.reason, 'serve-kitchen');
  r.startRally(1, -1);
  check('good serve', r.onBounce(-5, -15), null);
  check('receiver volleying the serve breaks two-bounce', r.onHit(-1, false, -18, 1)?.reason, 'two-bounce');
  r.startRally(1, -1);
  r.onBounce(-5, -15);
  check('return after the bounce is fine', r.onHit(-1, true, -20, 1), null);
  check('server volleying the return breaks two-bounce', r.onHit(1, false, 18, 2)?.reason, 'two-bounce');
  r.startRally(1, -1);
  r.onBounce(-5, -15);
  r.onHit(-1, true, -20, 1);
  r.onBounce(2, 15);
  r.onHit(1, true, 20, 2);
  check('volley from the kitchen is a fault', r.onHit(-1, false, -6.5, 3)?.reason, 'kitchen');
  r.startRally(1, -1);
  r.onBounce(-5, -15);
  r.onHit(-1, true, -20, 1);
  r.onBounce(2, 15);
  r.onHit(1, true, 20, 2);
  check('volley from behind the line is fine', r.onHit(-1, false, -8, 3), null);
  check('stepping in right after is a momentum fault', r.watchPlayer(-1, -7.1, 3.3)?.reason, 'kitchen-momentum');
  r.startRally(1, -1);
  r.onBounce(-5, -15);
  check('second bounce: receiver missed', r.onBounce(-6, -20), { side: -1, reason: 'double-bounce' });
  r.startRally(1, -1);
  check('serve into the net', r.onNet()?.reason, 'serve-net');
}
// --- doubles serving rotation
{
  const score = new Score({ ...DEFAULT_SCORING, teamSize: 2 }, 0);
  const rot = new ServeRotation(score);
  const state = () => `${score.call()} server ${rot.server.team}/${rot.server.seat} from ${rot.serverCourt} → receiver ${rot.receiver.team}/${rot.receiver.seat}`;
  const play = (winner: Team) => {
    const before = score.servingTeam;
    rot.afterRally(before, score.rallyWonBy(winner));
  };
  check('start: 0-0-2, seat 0 serves from the right to their diagonal', state(), '0-0-2 server 0/0 from right → receiver 1/0');
  play(0);
  check('server scores: partners swap, same server now from the left', state(), '1-0-2 server 0/0 from left → receiver 1/1');
  play(1);
  check('first-server exception: straight to side out, right-court player serves', state(), '0-1-1 server 1/0 from right → receiver 0/1');
  play(0);
  check('lose on first serve: partner becomes second server', state(), '0-1-2 server 1/1 from left → receiver 0/0');
  play(1);
  check('second server scores: team swaps, same server', state(), '1-1-2 server 1/1 from right → receiver 0/1');
  play(0);
  check('lose on second serve: side out to the right-court player', state(), '1-1-1 server 0/1 from right → receiver 1/1');
  check('receiving team never moved', [rot.courtOf(1, 0), rot.courtOf(1, 1)], ['left', 'right']);
}
{
  const score = new Score({ ...DEFAULT_SCORING, teamSize: 2, mode: 'rally' }, 0);
  const rot = new ServeRotation(score);
  rot.afterRally(0, score.rallyWonBy(1));
  check('rally doubles: winner serves from the court matching their (odd) score', [score.call(), rot.serverCourt], ['1-0', 'left']);
}
console.log(failed ? `\n${failed} FAILED` : '\nAll rules tests passed');
process.exit(failed ? 1 : 0);
