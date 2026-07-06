import type { Board, Branch } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeBranch } from '../BranchModal/testUtils';
import { BoardSwitcher } from './BoardSwitcher';

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    board_id: 'board-1',
    name: 'Board One',
    archived: false,
    ...overrides,
  } as unknown as Board;
}

function renderSwitcher(boards: Board[], branches: Branch[], currentBoardId?: string) {
  const branchById = new Map(branches.map((b) => [b.branch_id, b]));
  return render(
    <BoardSwitcher
      boards={boards}
      currentBoardId={currentBoardId}
      onBoardChange={() => {}}
      branchById={branchById}
    />
  );
}

function openDropdown() {
  // The closed trigger shows the current board (or Home) name.
  fireEvent.click(screen.getByRole('button'));
}

describe('BoardSwitcher attention indicators', () => {
  it('shows an attention badge on boards with branches needing attention', () => {
    const boards = [
      makeBoard({ board_id: 'board-1', name: 'Alpha' }),
      makeBoard({ board_id: 'board-2', name: 'Beta' }),
    ];
    const branches = [
      makeBranch({
        branch_id: 'br-1',
        board_id: 'board-1',
        needs_attention: true,
      } as Partial<Branch>),
      makeBranch({
        branch_id: 'br-2',
        board_id: 'board-1',
        needs_attention: true,
      } as Partial<Branch>),
      makeBranch({
        branch_id: 'br-3',
        board_id: 'board-2',
        needs_attention: false,
      } as Partial<Branch>),
    ];

    renderSwitcher(boards, branches, 'board-2');
    openDropdown();

    expect(screen.getByTitle('2 branches need attention')).toBeInTheDocument();
    expect(screen.queryByTitle(/branch needs attention/)).not.toBeInTheDocument();
    // Branch-count badges also carry explicit hover text.
    expect(screen.getByTitle('2 branches on this board')).toBeInTheDocument();
    expect(screen.getByTitle('1 branch on this board')).toBeInTheDocument();
  });

  it('shows a dot on the trigger only when a non-current board needs attention', () => {
    const boards = [
      makeBoard({ board_id: 'board-1', name: 'Alpha' }),
      makeBoard({ board_id: 'board-2', name: 'Beta' }),
    ];
    const branches = [
      makeBranch({
        branch_id: 'br-1',
        board_id: 'board-2',
        needs_attention: true,
      } as Partial<Branch>),
    ];

    const { unmount } = renderSwitcher(boards, branches, 'board-1');
    expect(screen.getByTitle('Another board has branches needing attention')).toBeInTheDocument();
    unmount();

    // Same attention state, but viewing the board that owns it — no dot.
    renderSwitcher(boards, branches, 'board-2');
    expect(
      screen.queryByTitle('Another board has branches needing attention')
    ).not.toBeInTheDocument();
  });

  it('renders no attention indicators when nothing needs attention', () => {
    const boards = [makeBoard({ board_id: 'board-1', name: 'Alpha' })];
    const branches = [
      makeBranch({
        branch_id: 'br-1',
        board_id: 'board-1',
        needs_attention: false,
      } as Partial<Branch>),
    ];

    renderSwitcher(boards, branches, 'board-1');
    openDropdown();

    expect(screen.queryByTitle(/attention/)).not.toBeInTheDocument();
  });
});
