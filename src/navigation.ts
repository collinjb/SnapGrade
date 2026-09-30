/** Route table. Four screens total, with the camera as the root so "back"
 *  from anywhere lands you ready to scan the next paper. */
export type RootStackParamList = {
  Camera: undefined;
  Results: { assignmentId: string; resultId: string };
  Summary: { assignmentId: string };
  AnswerKey: undefined;
  Settings: undefined;
};

declare global {
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
