/*
 * Copyright (C) 2022 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {sqliteString} from '../base/string_utils';
import {
  Area,
  PivotTableReduxQuery,
  PivotTableReduxState,
} from '../common/state';
import {toNs} from '../common/time';
import {
  getSelectedTrackIds,
} from '../controller/aggregation/slice_aggregation_controller';

import {globals} from './globals';
import {
  Aggregation,
  AggregationFunction,
  TableColumn,
  tableColumnEquals,
} from './pivot_table_redux_types';

export interface Table {
  name: string;
  columns: string[];
}

export const sliceTable = {
  name: 'slice',
  columns: ['type', 'ts', 'dur', 'category', 'name', 'depth'],
};

// Columns of `slice` table available for aggregation.
export const sliceAggregationColumns = [
  'ts',
  'dur',
  'depth',
  'thread_ts',
  'thread_dur',
  'thread_instruction_count',
  'thread_instruction_delta',
];

// List of available tables to query, used to populate selectors of pivot
// columns in the UI.
export const tables: Table[] = [
  sliceTable,
  {
    name: 'process',
    columns: [
      'type',
      'pid',
      'name',
      'parent_upid',
      'uid',
      'android_appid',
      'cmdline',
    ],
  },
  {name: 'thread', columns: ['type', 'name', 'tid', 'upid', 'is_main_thread']},
  {name: 'thread_track', columns: ['type', 'name', 'utid']},
];

// Queried "table column" is either:
// 1. A real one, represented as object with table and column name.
// 2. Pseudo-column 'count' that's rendered as '1' in SQL to use in queries like
// `select sum(1), name from slice group by name`.

export interface RegularColumn {
  kind: 'regular';
  table: string;
  column: string;
}

export interface ArgumentColumn {
  kind: 'argument';
  argument: string;
}

function outerAggregation(fn: AggregationFunction): AggregationFunction {
  if (fn === 'COUNT') {
    return 'SUM';
  }
  return fn;
}

// Exception thrown by query generator in case incoming parameters are not
// suitable in order to build a correct query; these are caught by the UI and
// displayed to the user.
export class QueryGeneratorError extends Error {}

// Internal column name for different rollover levels of aggregate columns.
function aggregationAlias(aggregationIndex: number): string {
  return `agg_${aggregationIndex}`;
}

export function areaFilter(area: Area): string {
  return `
    ts + dur > ${toNs(area.startSec)}
    and ts < ${toNs(area.endSec)}
    and track_id in (${getSelectedTrackIds(area).join(', ')})
  `;
}

export function expression(column: TableColumn): string {
  switch (column.kind) {
    case 'regular':
      return column.column;
    case 'argument':
      return extractArgumentExpression(column.argument);
  }
}

function aggregationExpression(aggregation: Aggregation): string {
  if (aggregation.aggregationFunction === 'COUNT') {
    return 'COUNT()';
  }
  return `${aggregation.aggregationFunction}(${
      expression(aggregation.column)})`;
}

export function extractArgumentExpression(argument: string, table?: string) {
  const prefix = table === undefined ? '' : `${table}.`;
  return `extract_arg(${prefix}arg_set_id, ${sqliteString(argument)})`;
}

function generateInnerQuery(
    pivots: TableColumn[],
    aggregations: Aggregation[],
    includeTrack: boolean,
    area: Area,
    constrainToArea: boolean): {query: string, groupByColumns: string[]} {
  const aggregationColumns: string[] = [];

  for (let i = 0; i < aggregations.length; i++) {
    aggregationColumns.push(
        `${aggregationExpression(aggregations[i])} as ${aggregationAlias(i)}`);
  }

  const selectColumns: string[] = [];
  const groupByColumns: string[] = [];

  let argumentCount = 0;
  for (const column of pivots) {
    switch (column.kind) {
      case 'regular': {
        selectColumns.push(column.column);
        groupByColumns.push(column.column);
        break;
      }
      case 'argument': {
        const alias = `pivot_argument_${argumentCount++}`;
        selectColumns.push(
            `${extractArgumentExpression(column.argument)} as ${alias}`);
        groupByColumns.push(alias);
        break;
      }
    }
  }
  if (includeTrack) {
    selectColumns.push('track_id');
  }

  const query = `
    select
      ${selectColumns.concat(aggregationColumns).join(',\n')}
    from slice
    ${(constrainToArea ? `where ${areaFilter(area)}` : '')}
    group by ${
      groupByColumns.concat(includeTrack ? ['track_id'] : []).join(', ')}
  `;

  return {query, groupByColumns};
}

export function aggregationIndex(pivotColumns: number, aggregationNo: number) {
  return pivotColumns + aggregationNo;
}

export function generateQueryFromState(
    state: PivotTableReduxState,
    ): PivotTableReduxQuery {
  if (state.selectionArea === undefined) {
    throw new QueryGeneratorError('Should not be called without area');
  }

  const sliceTableAggregations = [...state.selectedAggregations.values()];
  if (sliceTableAggregations.length === 0) {
    throw new QueryGeneratorError('No aggregations selected');
  }

  const nonSlicePivots = state.selectedPivots;
  const slicePivots = state.selectedSlicePivots;
  if (slicePivots.length === 0 && nonSlicePivots.length === 0) {
    throw new QueryGeneratorError('No pivots selected');
  }

  const outerAggregations = [];
  const innerQuery = generateInnerQuery(
      slicePivots,
      sliceTableAggregations,
      nonSlicePivots.length > 0,
      globals.state.areas[state.selectionArea.areaId],
      state.constrainToArea);

  const prefixedSlicePivots =
      innerQuery.groupByColumns.map((p) => `preaggregated.${p}`);
  const renderedNonSlicePivots =
      nonSlicePivots.map((pivot) => `${pivot.table}.${pivot.column}`);
  const sortCriteria =
      globals.state.nonSerializableState.pivotTableRedux.sortCriteria;
  const sortClauses: string[] = [];
  for (let i = 0; i < sliceTableAggregations.length; i++) {
    const agg = `preaggregated.${aggregationAlias(i)}`;
    const fn = outerAggregation(sliceTableAggregations[i].aggregationFunction);
    outerAggregations.push(`${fn}(${agg}) as ${aggregationAlias(i)}`);

    if (sortCriteria !== undefined &&
        tableColumnEquals(
            sliceTableAggregations[i].column, sortCriteria.column)) {
      sortClauses.push(`${aggregationAlias(i)} ${sortCriteria.order}`);
    }
  }

  const joins = `
    left join thread_track on thread_track.id = preaggregated.track_id
    left join thread using (utid)
    left join process using (upid)
  `;

  const text = `
    select
      ${
      renderedNonSlicePivots.concat(prefixedSlicePivots, outerAggregations)
          .join(',\n')}
    from (
      ${innerQuery.query}
    ) preaggregated
    ${nonSlicePivots.length > 0 ? joins : ''}
    group by ${renderedNonSlicePivots.concat(prefixedSlicePivots).join(', ')}
    ${sortClauses.length > 0 ? ('order by ' + sortClauses.join(', ')) : ''}
  `;

  return {
    text,
    metadata: {
      pivotColumns: (nonSlicePivots as TableColumn[]).concat(slicePivots),
      aggregationColumns: sliceTableAggregations,
    },
  };
}